/**
 * @file api/refresh-data.js
 * @description Background Worker that fetches, processes, probes, FILTERS,
 * and caches data using efficient batching.
 */

import { sendAlertToWebhook } from "./_lib/alerter.js";
import {
  setInCache,
  setMultipleInCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";
import {
  processIptvOrgSource,
  processCustomM3uSource,
  probeAndFilterStreamHealth,
} from "./_lib/data-processor.js"; // Updated import

export default async function handler(request, response) {
  const startTime = Date.now();

  if (
    process.env.NODE_ENV === "production" &&
    request.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  console.log("Starting background data refresh job...");

  const sources = [];
  try {
    sources.push(...JSON.parse(process.env.CUSTOM_M3U_SOURCES_JSON || "[]"));
  } catch (e) {
    console.error("Failed to parse CUSTOM_M3U_SOURCES_JSON.", e);
  }

  const results = await Promise.allSettled([
    processIptvOrgSource(),
    ...sources.map(processCustomM3uSource),
  ]);

  let aggregatedChannelList = [];
  const availableCatalogs = new Set();

  results.forEach((result, index) => {
    const isIptvOrg = index === 0;
    const sourceName = isIptvOrg ? "iptv-org" : sources[index - 1].name;
    if (result.status === "fulfilled" && result.value) {
      aggregatedChannelList.push(...result.value);
      if (isIptvOrg) {
        result.value.forEach(
          (c) => c.country?.name && availableCatalogs.add(c.country.name)
        );
      } else {
        availableCatalogs.add(sourceName);
      }
    } else {
      console.error(`Source "${sourceName}" failed.`, result.reason);
      sendAlertToWebhook(
        sourceName,
        result.reason || new Error("Unknown processing error")
      );
    }
  });

  console.log(
    `Total channels aggregated before health check: ${aggregatedChannelList.length}`
  );

  // --- CHANGE: Call the new probe and filter function ---
  const masterChannelList = await probeAndFilterStreamHealth(
    aggregatedChannelList
  );

  if (masterChannelList.length === 0) {
    const criticalError = new Error(
      "Master list is empty after health check. Aborting cache update."
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

    const individualChannelsToCache = {};
    masterChannelList.forEach((channel) => {
      individualChannelsToCache[`channel_${channel.id}`] = channel;
    });
    console.log(
      `Prepared ${
        Object.keys(individualChannelsToCache).length
      } healthy channels for batch caching.`
    );
    cachePromises.push(setMultipleInCache(individualChannelsToCache));

    const channelsByCatalog = {};
    masterChannelList.forEach((channel) => {
      const catalogName =
        channel.source === "iptv-org" ? channel.country?.name : channel.source;
      if (catalogName) {
        if (!channelsByCatalog[catalogName]) {
          channelsByCatalog[catalogName] = [];
        }
        channelsByCatalog[catalogName].push(channel);
      }
    });

    console.log("Storing individual catalogs...");
    for (const catalogName in channelsByCatalog) {
      cachePromises.push(
        setInCache(`catalog_${catalogName}`, channelsByCatalog[catalogName])
      );
    }

    console.log(`Storing master list and catalog list.`);
    cachePromises.push(setInCache(MASTER_CHANNEL_LIST_KEY, masterChannelList));
    cachePromises.push(
      setInCache(
        AVAILABLE_CATALOGS_KEY,
        sortedCatalogs.filter((c) => channelsByCatalog[c])
      )
    ); // Only store catalogs that have channels

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
