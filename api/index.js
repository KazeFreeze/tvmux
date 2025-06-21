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
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  console.log("GETADDON: Starting addon creation...");
  const getCatalogsStart = Date.now();

  // We still fetch the catalogs to know they exist, but we won't put them in the manifest.
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];
  console.log(
    `GETADDON: Fetched available catalogs in ${
      Date.now() - getCatalogsStart
    }ms. Count: ${availableCatalogs.length}`
  );

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.7", // Bump version to signify the fix
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
            // By removing the 'options' array, we default to a text input.
            // This avoids creating a massive manifest that causes the SDK to hang.
            // isRequired: false, // This is now implicit
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
  console.log("GETADDON: Addon builder configured.");

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

  console.log("GETADDON: Handlers defined. Returning interface.");
  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`HANDLER: Function handler started for URL: ${req.url}`);

  try {
    const addonInterface = await getAddon();
    console.log(
      `HANDLER: Addon interface created in ${Date.now() - handlerStartTime}ms.`
    );
    serveHTTP(addonInterface, { req, res });
    console.log(
      `HANDLER: serveHTTP called. Total setup and call time: ${
        Date.now() - handlerStartTime
      }ms.`
    );
  } catch (err) {
    console.error(
      "HANDLER: A critical error occurred during addon initialization.",
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
