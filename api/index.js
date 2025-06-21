/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe.
 */

import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;
import {
  getFromCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

/**
 * Creates and configures a new Stremio addon instance with dynamic data.
 * This function builds the FULL addon interface, required for the SDK's internal router
 * to handle catalog, meta, and stream requests correctly.
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  console.log("GETADDON: Starting full addon creation...");

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.8", // Bump version to signify the definitive fix
    name: "TVMux",
    description: "Resilient IPTV addon sourcing from public and custom lists.",
    resources: ["catalog", "meta", "stream"],
    types: ["tv"],
    catalogs: [
      {
        type: "tv",
        id: "tvmux-main-catalog",
        name: "TVMux Channels",
        extra: [
          {
            name: "genre",
            // This is required for the SDK to know how to handle genre filtering
            // when the user is browsing the catalog.
          },
        ],
      },
    ],
    idPrefixes: ["tvmux_"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  });
  console.log("GETADDON: Full addon builder configured.");

  // CATALOG HANDLER
  builder.defineCatalogHandler(async (args) => {
    const requestStartTime = Date.now();
    console.log(
      "CATALOG HANDLER: Received request.",
      JSON.stringify(args, null, 2)
    );

    const { type, id, extra } = args;
    if (type !== "tv" || id !== "tvmux-main-catalog") {
      return Promise.resolve({ metas: [] });
    }

    const selectedGenre = extra?.genre;
    let channelList = [];

    if (selectedGenre && selectedGenre !== "All") {
      const cacheKey = `catalog_${selectedGenre}`;
      console.log(`CATALOG HANDLER: FAST PATH. Key: '${cacheKey}'`);
      channelList = (await getFromCache(cacheKey)) || [];
    } else {
      console.log(`CATALOG HANDLER: SLOW PATH. Fetching master list.`);
      channelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    }

    if (channelList.length === 0) {
      console.warn(
        `CATALOG HANDLER: No channels found for genre: '${
          selectedGenre || "All"
        }'`
      );
      return Promise.resolve({ metas: [] });
    }

    const metas = channelList.map((channel) => ({
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
    }));

    console.log(
      `CATALOG HANDLER: Responding with ${metas.length} metas. Total time: ${
        Date.now() - requestStartTime
      }ms.`
    );
    return Promise.resolve({ metas });
  });

  // META HANDLER
  builder.defineMetaHandler(async (args) => {
    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === args.id);
    if (!channel) return Promise.resolve({ meta: null });
    return Promise.resolve({
      meta: {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: channel.logo,
        posterShape: "square",
      },
    });
  });

  // STREAM HANDLER
  builder.defineStreamHandler(async (args) => {
    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === args.id);
    if (!channel || !channel.streams || channel.streams.length === 0) {
      return Promise.resolve({ streams: [] });
    }
    const streams = channel.streams.map((stream) => ({
      url: stream.url,
      title: stream.health === "verified" ? "✅ Verified" : "❔ Untested",
    }));
    return Promise.resolve({ streams });
  });

  console.log("GETADDON: Full handlers defined. Returning interface.");
  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`HANDLER: Function handler started for URL: ${req.url}`);

  // FIX: Bypass the SDK for the manifest request to avoid timeouts.
  // We serve a lightweight, simplified manifest manually for fast installation.
  if (req.url === "/manifest.json" || req.url === "/") {
    console.log(
      "HANDLER: Bypassing SDK and serving lightweight manifest directly."
    );
    const lightweightManifest = {
      id: "com.tvmux.addon",
      version: "1.0.8",
      name: "TVMux",
      description:
        "Resilient IPTV addon sourcing from public and custom lists.",
      resources: ["catalog", "meta", "stream"],
      types: ["tv"],
      catalogs: [
        {
          type: "tv",
          id: "tvmux-main-catalog",
          name: "TVMux Channels",
          // Crucially, the 'extra' property is omitted here for performance.
        },
      ],
      idPrefixes: ["tvmux_"],
      behaviorHints: {
        configurable: true,
        configurationRequired: false,
      },
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(lightweightManifest));
    console.log(
      `HANDLER: Lightweight manifest served in ${
        Date.now() - handlerStartTime
      }ms.`
    );
    return;
  }

  // For all other requests (catalog, meta, stream), use the full SDK.
  try {
    const addonInterface = await getAddon();
    console.log(
      `HANDLER: Full addon interface created in ${
        Date.now() - handlerStartTime
      }ms.`
    );
    serveHTTP(addonInterface, { req, res });
    console.log(`HANDLER: Handed request to serveHTTP.`);
  } catch (err) {
    console.error(
      "HANDLER: A critical error occurred during full addon initialization.",
      err
    );
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: "Internal Server Error during addon initialization.",
        detail: err.message,
      })
    );
  }
}
