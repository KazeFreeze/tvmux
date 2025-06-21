/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe.
 */

import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;
import { getFromCache } from "./_lib/cache.js";

// A curated, limited list of popular countries for the dropdown menu.
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

function createManifest() {
  return {
    id: "com.tvmux.addon",
    version: "1.1.0",
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
            options: ["All", ...POPULAR_COUNTRIES],
            isRequired: true,
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

async function getAddon() {
  const builder = new addonBuilder(createManifest());

  // CATALOG HANDLER (No changes needed here)
  builder.defineCatalogHandler(async (args) => {
    const requestStartTime = Date.now();
    const { type, id, extra } = args;
    if (type !== "tv" || id !== "tvmux-main-catalog") {
      return Promise.resolve({ metas: [] });
    }
    const selectedGenre = extra?.genre;
    if (!selectedGenre || selectedGenre === "All") {
      return Promise.resolve({ metas: [] });
    }
    const cacheKey = `catalog_${selectedGenre}`;
    const channelList = (await getFromCache(cacheKey)) || [];
    if (channelList.length === 0) {
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
      `CATALOG HANDLER: Responding with ${metas.length} metas in ${
        Date.now() - requestStartTime
      }ms.`
    );
    return Promise.resolve({ metas });
  });

  // --- START OF CHANGE ---
  // META & STREAM HANDLERS are now optimized to fetch individual channels.
  // We no longer load the entire master list.

  builder.defineMetaHandler(async (args) => {
    const requestStartTime = Date.now();
    const { id } = args;
    console.log(`META HANDLER: Looking up meta for ID: ${id}`);

    // Fetch the specific channel directly from cache using its unique ID.
    const channel = await getFromCache(`channel_${id}`);

    if (!channel) {
      console.warn(`META HANDLER: Channel not found in cache for ID: ${id}`);
      return Promise.resolve({ meta: null });
    }

    const meta = {
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
      // You can add more details here if available in your channel object
      // description: channel.description,
      // genres: channel.categories,
    };

    console.log(
      `META HANDLER: Found '${channel.name}'. Responded in ${
        Date.now() - requestStartTime
      }ms.`
    );
    return Promise.resolve({ meta });
  });

  builder.defineStreamHandler(async (args) => {
    const requestStartTime = Date.now();
    const { id } = args;
    console.log(`STREAM HANDLER: Looking up streams for ID: ${id}`);

    // Fetch the specific channel directly from cache.
    const channel = await getFromCache(`channel_${id}`);

    if (!channel || !channel.streams || channel.streams.length === 0) {
      if (!channel) {
        console.warn(
          `STREAM HANDLER: Channel not found in cache for ID: ${id}`
        );
      } else {
        console.warn(
          `STREAM HANDLER: No streams found for channel '${channel.name}' (ID: ${id})`
        );
      }
      return Promise.resolve({ streams: [] });
    }

    const streams = channel.streams.map((stream) => ({
      url: stream.url,
      title:
        stream.health === "verified"
          ? `✅ ${stream.quality || "Verified"}`
          : `❔ ${stream.quality || "Untested"}`,
    }));

    console.log(
      `STREAM HANDLER: Found ${streams.length} streams for '${
        channel.name
      }'. Responded in ${Date.now() - requestStartTime}ms.`
    );
    return Promise.resolve({ streams });
  });
  // --- END OF CHANGE ---

  return builder.getInterface();
}

export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`HANDLER: Function handler started for URL: ${req.url}`);
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/manifest.json" || req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(createManifest()));
    return;
  }

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
      "HANDLER: A critical error occurred during initialization.",
      err
    );
    res.writeHead(500);
    res.end(
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
