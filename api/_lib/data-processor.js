/**
 * @file api/_lib/data-processor.js
 * @description Core data synthesis logic for all sources.
 * This module is the engine of the background worker. It contains functions to:
 * 1. Fetch and process the main iptv-org JSON API.
 * 2. Fetch and process custom M3U playlists.
 * 3. Normalize and enrich channel data from all sources.
 * 4. Perform best-effort health checks on stream URLs.
 */

import parser from "iptv-playlist-parser";
import httpClient from "./httpClient.js";
import axios from "axios";

// Create a separate HTTP client with longer timeout for background processing
const backgroundHttpClient = axios.create({
  timeout: 60000, // 60 seconds for background jobs
  maxContentLength: 50485760, // 50MB for large API responses
  maxRedirects: 0,
  validateStatus: function (status) {
    return status >= 200 && status < 300;
  },
});

const IPTV_ORG_API_URL = "https://iptv-org.github.io/api";
const DEFAULT_LOGO =
  "https://raw.githubusercontent.com/Stremio/stremio-dls/master/dist/logo-big.png";

/**
 * Normalizes a single channel object to a consistent application format.
 * Provides default fallbacks for missing critical data.
 * @param {object} channel - The raw channel object from parsing.
 * @param {string} sourceName - The name of the source (e.g., 'iptv-org', 'My Custom List').
 * @param {number} index - The index of the channel within its source.
 * @returns {object} The normalized channel object.
 */
function normalizeChannel(channel, sourceName, index) {
  // Determine name and logo with fallbacks
  const name = channel.name || channel.tvg?.name || "Unnamed Channel";
  const logo = channel.tvg?.logo || channel.logo || DEFAULT_LOGO;

  // For iptv-org, the streams are separate. For M3U, they are on the channel item.
  const streams = channel.streams || [
    {
      url: channel.url,
      // M3U parser may provide extra info in `channel.http`
      referrer: channel.http?.referrer || null,
      user_agent: channel.http?.["user-agent"] || null,
    },
  ];

  return {
    // Create a unique ID to prevent collisions between sources
    id: `tvmux_${sourceName.toLowerCase().replace(/\s/g, "-")}_${
      channel.id || index
    }`,
    name,
    logo,
    // Add source tag for filtering in the user-facing API
    source: sourceName,
    country: channel.country, // Will be enriched for iptv-org
    categories: channel.categories || [channel.group?.title || "General"],
    streams: streams.filter((s) => s.url), // Ensure streams have a URL
  };
}

/**
 * Processes the entire iptv-org dataset by fetching and merging multiple JSON endpoints.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of normalized channel objects.
 */
export async function processIptvOrgSource() {
  console.log("Starting iptv-org data processing...");

  try {
    // Use the background HTTP client with longer timeout
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

    console.log(
      `Fetched ${channels.length} channels, ${streams.length} streams from iptv-org.`
    );

    // Validate that we got meaningful data
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error("No channels received from iptv-org API");
    }
    if (!Array.isArray(streams) || streams.length === 0) {
      throw new Error("No streams received from iptv-org API");
    }

    // Create a map for efficient stream lookups
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
      // Honor the blocklist
      if (blocklist.has(channel.id)) continue;

      const channelStreams = streamsByChannel.get(channel.id) || [];
      if (channelStreams.length === 0) continue; // Skip channels with no streams

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
      `Finished processing iptv-org. Found ${processedChannels.length} valid channels.`
    );

    if (processedChannels.length === 0) {
      throw new Error("No valid channels after processing iptv-org data");
    }

    return processedChannels;
  } catch (error) {
    console.error("Error processing iptv-org source:", error);
    throw new Error(`iptv-org processing failed: ${error.message}`);
  }
}

/**
 * Processes a single custom M3U playlist from a URL.
 * @param {object} source - The source object, e.g., { id: 'my_list', name: 'My List', url: '...' }.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of normalized channel objects.
 */
export async function processCustomM3uSource(source) {
  console.log(`Processing custom M3U source: ${source.name}`);

  try {
    // Use background HTTP client for custom sources too
    const response = await backgroundHttpClient.get(source.url);
    const playlistContent = response.data;

    if (!playlistContent || typeof playlistContent !== "string") {
      throw new Error("Invalid or empty playlist content");
    }

    const result = parser.parse(playlistContent);

    if (!result || !Array.isArray(result.items)) {
      throw new Error("Failed to parse M3U playlist");
    }

    const processedChannels = result.items
      .map((channel, index) => normalizeChannel(channel, source.name, index))
      .filter((c) => c.streams.length > 0);

    console.log(
      `Finished processing ${source.name}. Found ${processedChannels.length} valid channels.`
    );

    return processedChannels;
  } catch (error) {
    console.error(`Error processing custom M3U source ${source.name}:`, error);
    throw new Error(
      `Custom M3U processing failed for ${source.name}: ${error.message}`
    );
  }
}

/**
 * Performs a HEAD request to a sample of stream URLs to check their health.
 * This function modifies the master list directly by adding a 'health' property.
 * @param {Array<object>} masterChannelList - The list of all channel objects.
 * @param {number} sampleSize - The number of streams to check.
 */
export async function probeStreamHealth(masterChannelList, sampleSize = 50) {
  console.log(`Probing health of up to ${sampleSize} random streams...`);
  const allStreams = masterChannelList.flatMap((channel) =>
    channel.streams.map((stream) => ({ ...stream, channelName: channel.name }))
  );

  // Get a random sample of streams
  const shuffled = allStreams.sort(() => 0.5 - Math.random());
  const sample = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

  const healthChecks = sample.map(async (stream) => {
    try {
      // Use the regular httpClient for health checks (shorter timeout is fine)
      const response = await httpClient.head(stream.url, { timeout: 5000 });
      if (response.status >= 200 && response.status < 400) {
        stream.health = "verified";
      } else {
        stream.health = "unverified";
      }
    } catch (error) {
      stream.health = "failed";
    }
  });

  await Promise.allSettled(healthChecks);
  console.log("Stream health probing complete.");
}
