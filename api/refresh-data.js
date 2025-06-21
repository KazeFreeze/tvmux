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
  // Basic security: check for a secret if running outside of Vercel's cron environment
  if (
    process.env.NODE_ENV === "production" &&
    request.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  console.log("Starting background data refresh job...");

  // 1. Define Sources
  const sources = [];
  const customM3uJson = process.env.CUSTOM_M3U_SOURCES_JSON || "[]";
  try {
    const customSources = JSON.parse(customM3uJson);
    sources.push(...customSources);
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

  // 2. Parallel Processing
  const processingPromises = [
    processIptvOrgSource(),
    ...sources.map((source) => processCustomM3uSource(source)),
  ];

  const results = await Promise.allSettled(processingPromises);

  let masterChannelList = [];
  const availableCatalogs = new Set();

  // The first result is always iptv-org
  const iptvOrgResult = results[0];
  if (iptvOrgResult.status === "fulfilled") {
    masterChannelList.push(...iptvOrgResult.value);
    iptvOrgResult.value.forEach((channel) =>
      availableCatalogs.add(channel.country.name)
    );
  } else {
    console.error(
      "CRITICAL: iptv-org source failed to process.",
      iptvOrgResult.reason
    );
    await sendAlertToWebhook("iptv-org", iptvOrgResult.reason);
  }

  // Process custom sources
  results.slice(1).forEach((result, index) => {
    const sourceName = sources[index].name;
    if (result.status === "fulfilled") {
      masterChannelList.push(...result.value);
      availableCatalogs.add(sourceName); // Add the source name as a catalog
    } else {
      console.error(`Source "${sourceName}" failed to process.`, result.reason);
      sendAlertToWebhook(sourceName, result.reason);
    }
  });

  console.log(
    `Total channels aggregated before health check: ${masterChannelList.length}`
  );

  // 3. Best-Effort Stream Probing
  if (masterChannelList.length > 0) {
    await probeStreamHealth(masterChannelList);
  }

  // 4. Store in Cache
  if (masterChannelList.length === 0) {
    const criticalError = new Error(
      "Master channel list is empty after processing. Aborting cache update."
    );
    console.error(criticalError.message);
    await sendAlertToWebhook("Cache Worker", criticalError);
    return response
      .status(500)
      .json({ status: "Failed", message: criticalError.message });
  }

  try {
    const sortedCatalogs = Array.from(availableCatalogs).sort();
    await setInCache(MASTER_CHANNEL_LIST_KEY, masterChannelList);
    await setInCache(AVAILABLE_CATALOGS_KEY, sortedCatalogs);
    console.log(
      `Successfully updated cache with ${masterChannelList.length} channels and ${sortedCatalogs.length} catalogs.`
    );
    return response
      .status(200)
      .json({ status: "Success", channels: masterChannelList.length });
  } catch (error) {
    console.error("Failed to write to cache.", error);
    await sendAlertToWebhook("Cache Writer", error);
    return response
      .status(500)
      .json({ status: "Failed", message: "Could not write to cache." });
  }
}
