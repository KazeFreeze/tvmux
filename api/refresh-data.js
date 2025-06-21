/**
 * @file api/refresh-data.js
 * @description Background Worker (Cron Job) serverless function.
 * This endpoint is triggered by Vercel Cron Jobs. It fetches data from all
 * defined sources, processes it, probes stream health, and stores the final
 * unified dataset in the Vercel KV cache.
 */

import { sendAlertToWebhook } from "./_lib/alerter.js";
import {
  setInCache,
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

  // Basic security: check for a secret if running outside of Vercel's cron environment
  if (
    process.env.NODE_ENV === "production" &&
    request.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  console.log("Starting background data refresh job...");

  // 1. Define Sources (Unchanged)
  const sources = [];
  const customM3uJson = process.env.CUSTOM_M3U_SOURCES_JSON || "[]";
  try {
    const customSources = JSON.parse(customM3uJson);
    sources.push(...customSources);
    console.log(`Loaded ${customSources.length} custom M3U sources`);
  } catch (e) {
    console.error(
      "Failed to parse CUSTOM_M3U_SOURCES_JSON. Skipping custom sources.",
      e
    );
    await sendAlertToWebhook(
      "JSON Parser",
      new Error("CUSTOM_M3U_SOURCES_JSON is invalid.")
    );
  }

  // 2. Parallel Processing (Unchanged)
  console.log("Starting to process iptv-org source...");
  const iptvOrgPromise = processIptvOrgSource();
  console.log(`Starting to process ${sources.length} custom sources...`);
  const customPromises = sources.map((source) => {
    console.log(`Processing custom source: ${source.name} (${source.url})`);
    return processCustomM3uSource(source);
  });
  const processingPromises = [iptvOrgPromise, ...customPromises];
  const results = await Promise.allSettled(processingPromises);

  let masterChannelList = [];
  const availableCatalogs = new Set();

  // (Processing results logic is unchanged...)
  const iptvOrgResult = results[0];
  if (iptvOrgResult.status === "fulfilled") {
    const iptvChannels = iptvOrgResult.value;
    masterChannelList.push(...iptvChannels);
    const countries = new Set();
    iptvChannels.forEach((channel) => {
      if (channel.country?.name) {
        countries.add(channel.country.name);
      }
    });
    countries.forEach((country) => availableCatalogs.add(country));
  } else {
    console.error("CRITICAL: iptv-org source failed.", iptvOrgResult.reason);
    await sendAlertToWebhook("iptv-org", iptvOrgResult.reason);
  }

  results.slice(1).forEach((result, index) => {
    const sourceName = sources[index].name;
    if (result.status === "fulfilled") {
      const customChannels = result.value;
      masterChannelList.push(...customChannels);
      availableCatalogs.add(sourceName);
    } else {
      console.error(`Source "${sourceName}" failed.`, result.reason);
      sendAlertToWebhook(sourceName, result.reason);
    }
  });

  console.log(`Total channels aggregated: ${masterChannelList.length}`);

  // 3. Best-Effort Stream Probing (Unchanged)
  if (masterChannelList.length > 0) {
    await probeStreamHealth(masterChannelList);
  }

  // 4. Store in Cache (OPTIMIZED)
  if (masterChannelList.length === 0) {
    const criticalError = new Error(
      "Master channel list is empty. Aborting cache update."
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

    // **NEW**: Group channels by their catalog name for optimized fetching
    const channelsByCatalog = {};
    sortedCatalogs.forEach((catalog) => (channelsByCatalog[catalog] = []));

    masterChannelList.forEach((channel) => {
      // Custom M3U sources use the source name as the catalog.
      // iptv-org channels use their country name as the catalog.
      const catalogName = availableCatalogs.has(channel.source)
        ? channel.source
        : channel.country?.name;

      if (catalogName && channelsByCatalog[catalogName]) {
        channelsByCatalog[catalogName].push(channel);
      }
    });

    console.log("Storing individual catalogs for performance...");
    for (const catalogName in channelsByCatalog) {
      const cacheKey = `catalog_${catalogName}`;
      const catalogChannels = channelsByCatalog[catalogName];
      if (catalogChannels.length > 0) {
        console.log(
          `  - Storing ${catalogChannels.length} channels for catalog: ${catalogName}`
        );
        cachePromises.push(setInCache(cacheKey, catalogChannels));
      }
    }

    // Store the master list (for meta/stream lookups) and the list of catalog names
    console.log(
      `Storing master list with ${masterChannelList.length} channels.`
    );
    cachePromises.push(setInCache(MASTER_CHANNEL_LIST_KEY, masterChannelList));
    cachePromises.push(setInCache(AVAILABLE_CATALOGS_KEY, sortedCatalogs));

    // Execute all cache operations in parallel
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
