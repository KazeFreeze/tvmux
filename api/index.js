/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless, dynamically building the addon interface
 * on each request using data from the Vercel KV cache.
 */

import { addonBuilder, serveHTTP } from "stremio-addon-sdk";
import {
  getFromCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

const CACHE_MAX_AGE = 60 * 5; // 5 minutes in seconds

/**
 * Creates and configures the Stremio addon interface.
 * This function is called on every request to ensure the addon's catalog
 * (genres/countries) is always up-to-date from the KV cache.
 * @returns {Promise<object>} A promise that resolves to a Stremio addon interface.
 */
async function getAddonInterface() {
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.1", // Bump version to signify update
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

  // === CATALOG HANDLER ===
  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log("Catalog request:", { type, id, extra });

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

  // === META HANDLER ===
  builder.defineMetaHandler(async ({ id }) => {
    console.log("Meta request for:", id);

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel) {
      return Promise.resolve({ meta: null });
    }

    const meta = {
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
    };

    return Promise.resolve({ meta });
  });

  // === STREAM HANDLER ===
  builder.defineStreamHandler(async ({ id }) => {
    console.log("Stream request for:", id);

    const masterChannelList =
      (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel || !channel.streams || channel.streams.length === 0) {
      return Promise.resolve({ streams: [] });
    }

    const sortedStreams = [...channel.streams].sort((a, b) => {
      if (a.health === "verified" && b.health !== "verified") return -1;
      if (a.health !== "verified" && b.health === "verified") return 1;
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
        if (stream.user_agent) {
          streamObj.behaviorHints.headers["User-Agent"] = stream.user_agent;
        }
        if (stream.referrer) {
          streamObj.behaviorHints.headers["Referer"] = stream.referrer;
        }
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
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Handle favicon.ico to prevent 404 errors in logs
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  // Serve a simple landing page for the root
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>TVMux Stremio Addon</h1><p>Addon is running. Add the manifest.json URL to Stremio.</p>"
    );
    return;
  }

  // Create the addon interface on-the-fly and let the SDK handle the request
  try {
    const addonInterface = await getAddonInterface();
    res.setHeader(
      "Cache-Control",
      `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${
        CACHE_MAX_AGE * 2
      }`
    );
    serveHTTP(addonInterface, req, res);
  } catch (err) {
    console.error("Error in main handler:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}
