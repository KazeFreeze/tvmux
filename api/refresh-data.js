/**
 * @file api/refresh-data.js
 * @description Background Worker (Cron Job) serverless function.
 * This endpoint is triggered by Vercel Cron Jobs. It fetches data, processes it,
 * and stores the final dataset in the Vercel KV cache using efficient batching.
 */

import { sendAlertToWebhook } from "./_lib/alerter.js";
import {
  setInCache,
  setMultipleInCache, // Import the new batch function
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";
import {
  processIptvOrgSource,
  processCustomM3uSource,
  probeStreamHealth,
} from "./_lib/data-processor.js";

export default async function handler(request, response) {
  const startTime = Date.now();

  if (
    process.env.NODE_ENV === "production" &&
    request.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  console.log("Starting background data refresh job...");

  // (Steps 1, 2, and 3: Fetching, Processing, and Probing are unchanged)
  const sources = [];
  const customM3uJson = process.env.CUSTOM_M3U_SOURCES_JSON || "[]";
  try {
    sources.push(...JSON.parse(customM3uJson));
  } catch (e) {
    console.error("Failed to parse CUSTOM_M3U_SOURCES_JSON.", e);
  }

  const results = await Promise.allSettled([
    processIptvOrgSource(),
    ...sources.map(processCustomM3uSource),
  ]);

  let masterChannelList = [];
  const availableCatalogs = new Set();

  const iptvOrgResult = results[0];
  if (iptvOrgResult.status === "fulfilled") {
    masterChannelList.push(...iptvOrgResult.value);
    iptvOrgResult.value.forEach((c) => availableCatalogs.add(c.country?.name));
  } else {
    console.error("CRITICAL: iptv-org source failed.", iptvOrgResult.reason);
    await sendAlertToWebhook("iptv-org", iptvOrgResult.reason);
  }

  results.slice(1).forEach((result, index) => {
    const sourceName = sources[index].name;
    if (result.status === "fulfilled") {
      masterChannelList.push(...result.value);
      availableCatalogs.add(sourceName);
    } else {
      console.error(`Source "${sourceName}" failed.`, result.reason);
      sendAlertToWebhook(sourceName, result.reason);
    }
  });

  console.log(`Total channels aggregated: ${masterChannelList.length}`);

  if (masterChannelList.length > 0) {
    await probeStreamHealth(masterChannelList);
  }

  // 4. Store in Cache (OPTIMIZED WITH BATCHING)
  if (masterChannelList.length === 0) {
    const criticalError = new Error(
      "Master list is empty. Aborting cache update."
    );
    console.error(criticalError.message);
    await sendAlertToWebhook("Cache Worker", criticalError);
    return response
      .status(500)
      .json({ status: "Failed", message: criticalError.message });
  }

  try {
    const cachePromises = [];
    const sortedCatalogs = Array.from(availableCatalogs).sort();

    // --- START OF MAJOR CHANGE ---
    // Prepare a single object for a batch `mset` operation for all individual channels.
    // This is much more efficient than thousands of individual `set` calls.
    const individualChannelsToCache = {};
    masterChannelList.forEach((channel) => {
      const individualChannelKey = `channel_${channel.id}`;
      individualChannelsToCache[individualChannelKey] = channel;
    });

    console.log(
      `Prepared ${
        Object.keys(individualChannelsToCache).length
      } individual channels for batch caching.`
    );
    // Add the single batch operation to our list of promises.
    cachePromises.push(setMultipleInCache(individualChannelsToCache));
    // --- END OF MAJOR CHANGE ---

    const channelsByCatalog = {};
    sortedCatalogs.forEach((catalog) => (channelsByCatalog[catalog] = []));
    masterChannelList.forEach((channel) => {
      const catalogName = availableCatalogs.has(channel.source)
        ? channel.source
        : channel.country?.name;
      if (catalogName && channelsByCatalog[catalogName]) {
        channelsByCatalog[catalogName].push(channel);
      }
    });

    console.log("Storing individual catalogs...");
    for (const catalogName in channelsByCatalog) {
      const cacheKey = `catalog_${catalogName}`;
      const catalogChannels = channelsByCatalog[catalogName];
      if (catalogChannels.length > 0) {
        // These are fewer, so individual sets are fine.
        cachePromises.push(setInCache(cacheKey, catalogChannels));
      }
    }

    console.log(`Storing master list and catalog list.`);
    cachePromises.push(setInCache(MASTER_CHANNEL_LIST_KEY, masterChannelList));
    cachePromises.push(setInCache(AVAILABLE_CATALOGS_KEY, sortedCatalogs));

    // Execute all cache operations in parallel. This will now be much faster.
    await Promise.all(cachePromises);

    const processingTime = Date.now() - startTime;
    console.log(`Successfully updated cache in ${processingTime}ms.`);

    return response.status(200).json({
      status: "Success",
      channels: masterChannelList.length,
      catalogs: sortedCatalogs.length,
      processingTime,
    });
  } catch (error) {
    console.error("Failed to write to cache.", error);
    await sendAlertToWebhook("Cache Writer", error);
    return response
      .status(500)
      .json({ status: "Failed", message: "Could not write to cache." });
  }
}
