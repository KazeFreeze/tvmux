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
    id: `${sourceName.toLowerCase().replace(/\s/g, "-")}_${
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
  const [channelsRes, streamsRes, countriesRes, categoriesRes, blocklistRes] =
    await Promise.all([
      httpClient.get(`${IPTV_ORG_API_URL}/channels.json`),
      httpClient.get(`${IPTV_ORG_API_URL}/streams.json`),
      httpClient.get(`${IPTV_ORG_API_URL}/countries.json`),
      httpClient.get(`${IPTV_ORG_API_URL}/categories.json`),
      httpClient.get(`${IPTV_ORG_API_URL}/blocklist.json`),
    ]);

  const channels = channelsRes.data;
  const streams = streamsRes.data;
  const countries = new Map(countriesRes.data.map((c) => [c.code, c]));
  const categories = new Map(categoriesRes.data.map((c) => [c.id, c.name]));
  const blocklist = new Set(blocklistRes.data.map((item) => item.channel));

  console.log(
    `Fetched ${channels.length} channels, ${streams.length} streams from iptv-org.`
  );

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
      country: countries.get(channel.country) || { name: channel.country },
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
  return processedChannels;
}

/**
 * Processes a single custom M3U playlist from a URL.
 * @param {object} source - The source object, e.g., { id: 'my_list', name: 'My List', url: '...' }.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of normalized channel objects.
 */
export async function processCustomM3uSource(source) {
  console.log(`Processing custom M3U source: ${source.name}`);
  const response = await httpClient.get(source.url);
  const playlistContent = response.data;
  const result = parser.parse(playlistContent);

  const processedChannels = result.items
    .map((channel, index) => normalizeChannel(channel, source.name, index))
    .filter((c) => c.streams.length > 0);

  console.log(
    `Finished processing ${source.name}. Found ${processedChannels.length} valid channels.`
  );
  return processedChannels;
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
      // Use a shorter timeout for health checks
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
