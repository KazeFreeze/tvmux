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

  // 1. Define Sources
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

  // 2. Parallel Processing with detailed logging
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

  // The first result is always iptv-org
  const iptvOrgResult = results[0];
  console.log(`iptv-org result status: ${iptvOrgResult.status}`);

  if (iptvOrgResult.status === "fulfilled") {
    const iptvChannels = iptvOrgResult.value;
    console.log(`iptv-org provided ${iptvChannels.length} channels`);
    masterChannelList.push(...iptvChannels);

    // Add unique countries to catalogs
    const countries = new Set();
    iptvChannels.forEach((channel) => {
      if (channel.country?.name) {
        countries.add(channel.country.name);
      }
    });
    countries.forEach((country) => availableCatalogs.add(country));

    console.log(`Added ${countries.size} countries to catalogs from iptv-org`);
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
    console.log(
      `Custom source "${sourceName}" result status: ${result.status}`
    );

    if (result.status === "fulfilled") {
      const customChannels = result.value;
      console.log(
        `Custom source "${sourceName}" provided ${customChannels.length} channels`
      );
      masterChannelList.push(...customChannels);
      availableCatalogs.add(sourceName); // Add the source name as a catalog
    } else {
      console.error(`Source "${sourceName}" failed to process.`, result.reason);
      sendAlertToWebhook(sourceName, result.reason);
    }
  });

  console.log(
    `Total channels aggregated before health check: ${masterChannelList.length}`
  );
  console.log(`Total catalogs available: ${availableCatalogs.size}`);

  // 3. Best-Effort Stream Probing
  if (masterChannelList.length > 0) {
    console.log("Starting stream health probing...");
    await probeStreamHealth(masterChannelList);
    console.log("Stream health probing completed");
  } else {
    console.log("Skipping stream health probing - no channels available");
  }

  // 4. Store in Cache
  if (masterChannelList.length === 0) {
    const criticalError = new Error(
      "Master channel list is empty after processing. Aborting cache update."
    );
    console.error(criticalError.message);
    console.error("Processing summary:");
    console.error(`- iptv-org status: ${results[0].status}`);
    if (results[0].status === "rejected") {
      console.error(`- iptv-org error: ${results[0].reason.message}`);
    }
    console.error(`- Custom sources processed: ${sources.length}`);
    results.slice(1).forEach((result, index) => {
      console.error(`- ${sources[index].name}: ${result.status}`);
      if (result.status === "rejected") {
        console.error(`  Error: ${result.reason.message}`);
      }
    });

    await sendAlertToWebhook("Cache Worker", criticalError);
    return response.status(500).json({
      status: "Failed",
      message: criticalError.message,
      processingTime: Date.now() - startTime,
      details: {
        iptvOrgStatus: results[0].status,
        iptvOrgError:
          results[0].status === "rejected" ? results[0].reason.message : null,
        customSourcesCount: sources.length,
        customSourcesResults: results.slice(1).map((r, i) => ({
          name: sources[i].name,
          status: r.status,
          error: r.status === "rejected" ? r.reason.message : null,
        })),
      },
    });
  }

  try {
    const sortedCatalogs = Array.from(availableCatalogs).sort();
    await setInCache(MASTER_CHANNEL_LIST_KEY, masterChannelList);
    await setInCache(AVAILABLE_CATALOGS_KEY, sortedCatalogs);

    const processingTime = Date.now() - startTime;
    console.log(
      `Successfully updated cache with ${masterChannelList.length} channels and ${sortedCatalogs.length} catalogs in ${processingTime}ms.`
    );

    return response.status(200).json({
      status: "Success",
      channels: masterChannelList.length,
      catalogs: sortedCatalogs.length,
      processingTime,
      sources: {
        iptvOrg:
          results[0].status === "fulfilled" ? results[0].value.length : 0,
        custom: results.slice(1).map((r, i) => ({
          name: sources[i].name,
          channels: r.status === "fulfilled" ? r.value.length : 0,
        })),
      },
    });
  } catch (error) {
    console.error("Failed to write to cache.", error);
    await sendAlertToWebhook("Cache Writer", error);
    return response.status(500).json({
      status: "Failed",
      message: "Could not write to cache.",
      processingTime: Date.now() - startTime,
    });
  }
}
