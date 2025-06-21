/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe.
 */

import { addonBuilder } from "stremio-addon-sdk";
import {
  getFromCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

const CACHE_MAX_AGE = 60 * 5; // 5 minutes in seconds

/**
 * Creates and configures a new Stremio addon instance with dynamic data.
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.2", // Bump version to signify this fix
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
      return { metas: [] };
    }

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    if (masterChannelList.length === 0) {
      return { metas: [] };
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

    return { metas };
  });

  // META HANDLER
  builder.defineMetaHandler(async (args) => {
    console.log("Meta request for:", args);
    const { id } = args;

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel) return { meta: null };

    return {
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
    };
  });

  // STREAM HANDLER
  builder.defineStreamHandler(async (args) => {
    console.log("Stream request for:", args);
    const { id } = args;

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel || !channel.streams || channel.streams.length === 0) {
      return { streams: [] };
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

    return { streams };
  });

  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Cache-Control",
    `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${
      CACHE_MAX_AGE * 2
    }`
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  console.log(`Handling request: ${path}`);

  if (path === "/favicon.ico") {
    return res.status(204).end();
  }

  try {
    const addonInterface = await getAddon();
    let result;

    if (path === "/manifest.json" || path === "/") {
      result = addonInterface.manifest;
    } else if (path.startsWith("/catalog/")) {
      const [, , type, id, extra] = path.replace(".json", "").split("/");
      result = await addonInterface.catalog.get({
        type,
        id,
        extra: extra ? new URLSearchParams(extra).toString() : null,
      });
    } else if (path.startsWith("/meta/")) {
      const [, , type, id] = path.replace(".json", "").split("/");
      result = await addonInterface.meta.get({ type, id });
    } else if (path.startsWith("/stream/")) {
      const [, , type, id] = path.replace(".json", "").split("/");
      result = await addonInterface.stream.get({ type, id });
    } else if (path === "/configure") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(
        "<h1>Configuration is handled automatically in Stremio.</h1>"
      );
    } else {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: "Not Found" }));
    }

    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error("Handler error:", err);
    res.writeHead(500);
    res.end(
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
