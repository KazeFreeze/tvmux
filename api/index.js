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
    version: "1.0.5", // Bump version for debugging
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

  // CATALOG HANDLER (WITH ENHANCED DEBUGGING)
  builder.defineCatalogHandler(async (args) => {
    const requestStartTime = Date.now();
    console.log(
      "CATALOG HANDLER: Received request.",
      JSON.stringify(args, null, 2)
    );

    const { type, id, extra } = args;

    if (type !== "tv" || id !== "tvmux-main-catalog") {
      console.log("CATALOG HANDLER: Exiting, invalid type/id.");
      return Promise.resolve({ metas: [] });
    }

    const selectedGenre = extra?.genre;
    console.log(`CATALOG HANDLER: Parsed selectedGenre as: '${selectedGenre}'`);

    let channelList = [];

    if (selectedGenre && selectedGenre !== "All") {
      // FAST PATH
      const cacheKey = `catalog_${selectedGenre}`;
      console.log(
        `CATALOG HANDLER: Taking FAST PATH. Fetching from cache key: '${cacheKey}'`
      );
      try {
        const fetchStartTime = Date.now();
        channelList = (await getFromCache(cacheKey)) || [];
        console.log(
          `CATALOG HANDLER: FAST PATH fetch complete in ${
            Date.now() - fetchStartTime
          }ms. Found ${channelList.length} channels.`
        );
      } catch (e) {
        console.error(
          `CATALOG HANDLER: FAST PATH ERROR fetching from cache.`,
          e
        );
        return Promise.resolve({ metas: [] });
      }
    } else {
      // SLOW PATH
      console.log(
        `CATALOG HANDLER: Taking SLOW PATH for genre '${selectedGenre}'. Fetching master list.`
      );
      try {
        const fetchStartTime = Date.now();
        channelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
        console.log(
          `CATALOG HANDLER: SLOW PATH fetch complete in ${
            Date.now() - fetchStartTime
          }ms. Found ${channelList.length} channels.`
        );
      } catch (e) {
        console.error(
          `CATALOG HANDLER: SLOW PATH ERROR fetching from cache.`,
          e
        );
        return Promise.resolve({ metas: [] });
      }
    }

    if (channelList.length === 0) {
      console.warn(
        `CATALOG HANDLER: No channels found for genre: '${
          selectedGenre || "All"
        }'`
      );
      return Promise.resolve({ metas: [] });
    }

    const mapStartTime = Date.now();
    const metas = channelList.map((channel) => ({
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
    }));
    console.log(
      `CATALOG HANDLER: Mapping to metas took ${Date.now() - mapStartTime}ms.`
    );

    console.log(
      `CATALOG HANDLER: Responding with ${metas.length} metas. Total time: ${
        Date.now() - requestStartTime
      }ms.`
    );
    return Promise.resolve({ metas });
  });

  // META HANDLER (Unchanged)
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
