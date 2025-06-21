/**
 * @file api/_lib/data-processor.js
 * @description Core data synthesis logic for all sources.
 * This module fetches, processes, normalizes, probes, and filters channel data
 * to ensure only healthy channels are cached.
 */

import parser from "iptv-playlist-parser";
import httpClient from "./httpClient.js";
import axios from "axios";

// Create a separate HTTP client with a longer timeout for fetching large source files
const backgroundHttpClient = axios.create({
  timeout: 60000,
  maxContentLength: 50485760, // 50MB
  maxRedirects: 0,
  validateStatus: (status) => status >= 200 && status < 300,
});

const IPTV_ORG_API_URL = "https://iptv-org.github.io/api";
const DEFAULT_LOGO =
  "https://raw.githubusercontent.com/Stremio/stremio-dls/master/dist/logo-big.png";

function normalizeChannel(channel, sourceName, index) {
  const name = channel.name || channel.tvg?.name || "Unnamed Channel";
  const logo = channel.tvg?.logo || channel.logo || DEFAULT_LOGO;
  const streams = (channel.streams || [{ url: channel.url }]).filter(
    (s) => s.url
  );

  return {
    id: `tvmux_${sourceName.toLowerCase().replace(/\s/g, "-")}_${
      channel.id || index
    }`,
    name,
    logo,
    source: sourceName,
    country: channel.country,
    categories: channel.categories || [channel.group?.title || "General"],
    streams: streams.map((s) => ({ ...s, health: "unverified" })), // Default health
  };
}

export async function processIptvOrgSource() {
  console.log("Starting iptv-org data processing...");
  try {
    const [channelsRes, streamsRes, countriesRes, categoriesRes, blocklistRes] =
      await Promise.all([
        backgroundHttpClient.get(`${IPTV_ORG_API_URL}/channels.json`),
        backgroundHttpClient.get(`${IPTV_ORG_API_URL}/streams.json`),
        backgroundHttpClient.get(`${IPTV_ORG_API_URL}/countries.json`),
        backgroundHttpClient.get(`${IPTV_ORG_API_URL}/categories.json`),
        backgroundHttpClient.get(`${IPTV_ORG_API_URL}/blocklist.json`),
      ]);

    const channels = channelsRes.data;
    const streams = streamsRes.data;
    const countries = new Map(countriesRes.data.map((c) => [c.code, c]));
    const categories = new Map(categoriesRes.data.map((c) => [c.id, c.name]));
    const blocklist = new Set(blocklistRes.data.map((item) => item.channel));

    const streamsByChannel = new Map();
    for (const stream of streams) {
      if (!streamsByChannel.has(stream.channel)) {
        streamsByChannel.set(stream.channel, []);
      }
      streamsByChannel.get(stream.channel).push({
        url: stream.url,
        user_agent: stream.user_agent,
        referrer: stream.referrer,
        quality: stream.quality,
        status: stream.status,
      });
    }

    const processedChannels = [];
    for (const channel of channels) {
      if (blocklist.has(channel.id)) continue;
      const channelStreams = streamsByChannel.get(channel.id) || [];
      if (channelStreams.length === 0) continue;

      const enrichedChannel = {
        ...channel,
        country: countries.get(channel.country) || {
          name: channel.country || "Unknown",
        },
        categories: (channel.categories || []).map(
          (catId) => categories.get(catId) || catId
        ),
        streams: channelStreams,
      };
      processedChannels.push(
        normalizeChannel(enrichedChannel, "iptv-org", channel.id)
      );
    }

    console.log(
      `Finished processing iptv-org. Found ${processedChannels.length} candidate channels.`
    );
    return processedChannels;
  } catch (error) {
    console.error("Error processing iptv-org source:", error);
    throw new Error(`iptv-org processing failed: ${error.message}`);
  }
}

export async function processCustomM3uSource(source) {
  console.log(`Processing custom M3U source: ${source.name}`);
  try {
    const response = await backgroundHttpClient.get(source.url);
    const result = parser.parse(response.data);
    const processedChannels = result.items
      .map((channel, index) => normalizeChannel(channel, source.name, index))
      .filter((c) => c.streams.length > 0);
    console.log(
      `Finished processing ${source.name}. Found ${processedChannels.length} channels.`
    );
    return processedChannels;
  } catch (error) {
    console.error(`Error processing custom M3U source ${source.name}:`, error);
    throw new Error(`Custom M3U failed for ${source.name}: ${error.message}`);
  }
}

/**
 * --- BATCHED HEALTH PROBE LOGIC ---
 * Performs HEAD requests in batches to prevent overwhelming the serverless function.
 * It then filters out channels that have no working streams.
 * @param {Array<object>} masterChannelList - The list of all channel objects.
 * @returns {Array<object>} The filtered list of channels with at least one healthy stream.
 */
export async function probeAndFilterStreamHealth(masterChannelList) {
  const allStreams = masterChannelList.flatMap((channel) => channel.streams);
  console.log(
    `Probing health of ${allStreams.length} streams from ${masterChannelList.length} channels...`
  );

  const PROBE_TIMEOUT = 5000; // 5 seconds per stream
  const BATCH_SIZE = 200; // Number of streams to check concurrently
  let verifiedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < allStreams.length; i += BATCH_SIZE) {
    const batch = allStreams.slice(i, i + BATCH_SIZE);
    console.log(
      `Probing batch ${i / BATCH_SIZE + 1}... (${batch.length} streams)`
    );

    const healthChecks = batch.map(async (stream) => {
      try {
        const response = await httpClient.head(stream.url, {
          timeout: PROBE_TIMEOUT,
        });
        if (response.status >= 200 && response.status < 400) {
          stream.health = "verified";
        } else {
          stream.health = "failed";
        }
      } catch (error) {
        stream.health = "failed";
      }
    });

    await Promise.allSettled(healthChecks);
  }

  // Tally the results after all batches are done
  allStreams.forEach((stream) => {
    if (stream.health === "verified") verifiedCount++;
    else failedCount++;
  });

  console.log(
    `Stream health probing complete. Verified: ${verifiedCount}, Failed: ${failedCount}.`
  );

  const healthyChannels = masterChannelList.filter((channel) => {
    const hasAtLeastOneVerifiedStream = channel.streams.some(
      (stream) => stream.health === "verified"
    );
    return hasAtLeastOneVerifiedStream;
  });

  console.log(
    `Filtering complete. Kept ${healthyChannels.length} channels with at least one verified stream.`
  );
  return healthyChannels;
}
