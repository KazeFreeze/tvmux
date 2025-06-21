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
  MASTER_CHANNEL_LIST_KEY, // Still used for meta/stream lookups
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

/**
 * Creates and configures a new Stremio addon instance with dynamic data.
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.4", // Bump version to signify optimization
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
            options:
              availableCatalogs.length > 0
                ? ["All", ...availableCatalogs]
                : ["All"],
            isRequired: false,
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

  // CATALOG HANDLER (OPTIMIZED)
  builder.defineCatalogHandler(async (args) => {
    console.log("Catalog request:", args);
    const { type, id, extra } = args;

    if (type !== "tv" || id !== "tvmux-main-catalog") {
      return Promise.resolve({ metas: [] });
    }

    const selectedGenre = extra?.genre;
    let channelList = [];

    // If a specific genre is selected, fetch only that pre-filtered list.
    // This is much faster than loading the entire master list.
    if (selectedGenre && selectedGenre !== "All") {
      console.log(`Fetching optimized catalog for genre: ${selectedGenre}`);
      const cacheKey = `catalog_${selectedGenre}`;
      channelList = (await getFromCache(cacheKey)) || [];
    } else {
      // Fallback to the full list for "All" or default view. This will still be slow.
      console.log('Fetching master channel list for "All" genre...');
      channelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    }

    if (channelList.length === 0) {
      console.warn(`No channels found for genre: ${selectedGenre || "All"}`);
      return Promise.resolve({ metas: [] });
    }

    const metas = channelList.map((channel) => ({
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
    }));

    return Promise.resolve({ metas });
  });

  // META HANDLER (Unchanged)
  // This still relies on the master list for individual lookups, which is acceptable.
  builder.defineMetaHandler(async (args) => {
    console.log("Meta request for:", args);
    const { id } = args;

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel) return Promise.resolve({ meta: null });

    return Promise.resolve({
      meta: {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: channel.logo,
        posterShape: "square",
        logo: channel.logo,
        background: "https://dl.strem.io/addon-background.jpg",
        description: `Source: ${channel.source}\nCategories: ${(
          channel.categories || []
        ).join(", ")}`,
      },
    });
  });

  // STREAM HANDLER (Unchanged)
  builder.defineStreamHandler(async (args) => {
    console.log("Stream request for:", args);
    const { id } = args;

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel || !channel.streams || channel.streams.length === 0) {
      return Promise.resolve({ streams: [] });
    }

    const sortedStreams = [...channel.streams].sort((a, b) => {
      if (a.health === "verified" && b.health !== "verified") return -1;
      if (b.health === "verified" && a.health !== "verified") return 1;
      return 0;
    });

    const streams = sortedStreams.map((stream) => {
      const streamObj = {
        url: stream.url,
        title: `${
          stream.health === "verified" ? "✅ Verified" : "❔ Untested"
        }`,
      };
      if (stream.user_agent || stream.referrer) {
        streamObj.behaviorHints = { headers: {} };
        if (stream.user_agent)
          streamObj.behaviorHints.headers["User-Agent"] = stream.user_agent;
        if (stream.referrer)
          streamObj.behaviorHints.headers["Referer"] = stream.referrer;
      }
      return streamObj;
    });

    return Promise.resolve({ streams });
  });

  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  try {
    const addonInterface = await getAddon();
    serveHTTP(addonInterface, { req, res });
  } catch (err) {
    console.error("Handler initialization error:", err);
    res.writeHead(500);
    res.end(
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
