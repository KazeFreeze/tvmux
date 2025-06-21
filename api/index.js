/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe.
 */

import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;
import { getFromCache, MASTER_CHANNEL_LIST_KEY } from "./_lib/cache.js";

// A curated, limited list of popular countries for the dropdown menu.
// This keeps the manifest small and fast, preventing SDK timeouts.
// The user can still search for any other country via the search bar.
const POPULAR_COUNTRIES = [
  "Argentina",
  "Australia",
  "Brazil",
  "Canada",
  "France",
  "Germany",
  "India",
  "Indonesia",
  "Italy",
  "Mexico",
  "Netherlands",
  "Philippines",
  "Poland",
  "Portugal",
  "Russia",
  "South Korea",
  "Spain",
  "Turkiye",
  "United Kingdom",
  "United States",
];

/**
 * Creates a lean manifest object. This is used for both the manual bypass
 * and the full addon builder to ensure consistency.
 * @returns {object} A manifest object.
 */
function createManifest() {
  return {
    id: "com.tvmux.addon",
    version: "1.1.0", // Final version
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
            // Restore the dropdown with a limited, performant list.
            options: ["All", ...POPULAR_COUNTRIES],
            isRequired: true, // Force user to make a selection
          },
        ],
      },
    ],
    idPrefixes: ["tvmux_"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

/**
 * Creates and configures the full Stremio addon instance.
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  // Use the consistent, lightweight manifest for the builder.
  const builder = new addonBuilder(createManifest());

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

    // If "All" or no genre is selected, return an empty list immediately.
    // This prevents the timeout on the default view.
    if (!selectedGenre || selectedGenre === "All") {
      console.log(
        "CATALOG HANDLER: 'All' or no genre selected. Returning empty list to prompt user selection."
      );
      return Promise.resolve({ metas: [] });
    }

    // FAST PATH ONLY: Fetch the pre-filtered list for the selected genre.
    const cacheKey = `catalog_${selectedGenre}`;
    console.log(`CATALOG HANDLER: Fetching from cache key: '${cacheKey}'`);
    const channelList = (await getFromCache(cacheKey)) || [];

    if (channelList.length === 0) {
      console.warn(
        `CATALOG HANDLER: No channels found for genre: '${selectedGenre}'`
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

  // META & STREAM HANDLERS (Still require the master list for lookups)
  const masterChannelListPromise = getFromCache(MASTER_CHANNEL_LIST_KEY);

  builder.defineMetaHandler(async (args) => {
    const masterChannelList = (await masterChannelListPromise) || [];
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

  builder.defineStreamHandler(async (args) => {
    const masterChannelList = (await masterChannelListPromise) || [];
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

  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`HANDLER: Function handler started for URL: ${req.url}`);

  // Set CORS header for all responses
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Manual bypass for manifest request
  if (req.url === "/manifest.json" || req.url === "/") {
    console.log(
      "HANDLER: Bypassing SDK and serving lightweight manifest directly."
    );
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(createManifest()));
    console.log(
      `HANDLER: Lightweight manifest served in ${
        Date.now() - handlerStartTime
      }ms.`
    );
    return;
  }

  // Use the full SDK for all other requests
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
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
