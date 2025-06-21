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
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.3", // Bump version to signify this fix
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

  // CATALOG HANDLER
  builder.defineCatalogHandler(async (args) => {
    console.log("Catalog request:", args);
    const { type, id, extra } = args;

    if (type !== "tv" || id !== "tvmux-main-catalog") {
      return Promise.resolve({ metas: [] });
    }

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    if (masterChannelList.length === 0) {
      return Promise.resolve({ metas: [] });
    }

    const selectedGenre = extra?.genre;
    const filteredList =
      selectedGenre && selectedGenre !== "All"
        ? masterChannelList.filter(
            (c) =>
              c.source === selectedGenre || c.country?.name === selectedGenre
          )
        : masterChannelList;

    const metas = filteredList.map((channel) => ({
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
    }));

    return Promise.resolve({ metas });
  });

  // META HANDLER
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

  // STREAM HANDLER
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
  // FIX: Use the official 'serveHTTP' function from the SDK.
  // This is the recommended and most robust way to create a Stremio addon server.
  // It handles all routing, request parsing, and response writing automatically,
  // preventing subtle bugs that can occur with manual implementations.
  try {
    const addonInterface = await getAddon();
    serveHTTP(addonInterface, { req, res });
  } catch (err) {
    // This will catch errors that happen during addonInterface creation.
    // Errors during request handling are managed internally by serveHTTP.
    console.error("Handler initialization error:", err);
    res.writeHead(500);
    res.end(
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
