/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is designed to be lightweight and fast, reading pre-computed data
 * from the Vercel KV cache and formatting it for Stremio.
 */

import { addonBuilder } from "stremio-addon-sdk";
import {
  getFromCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

const CACHE_MAX_AGE = 60 * 5; // 5 minutes in seconds for browser/cdn caching

// In-memory cache for the manifest to avoid hitting KV on every manifest request.
let manifestCache = null;
let manifestCacheTime = null;

// Create the addon builder with proper manifest structure
const builder = new addonBuilder({
  id: "com.tvmux.addon",
  version: "1.0.0",
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
          options: [], // Will be populated dynamically
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

// === DYNAMIC MANIFEST GENERATION ===
async function getDynamicManifest() {
  const now = Date.now();
  if (manifestCache && manifestCacheTime && now - manifestCacheTime < 300000) {
    // 5 min TTL
    return manifestCache;
  }

  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];
  const baseManifest = builder.getInterface();

  // Create a new manifest with dynamic catalogs, preserving all required fields
  const manifest = {
    ...baseManifest,
    catalogs: [
      {
        type: "tv",
        id: "tvmux-main-catalog",
        name: "TVMux Channels",
        extra: [
          {
            name: "genre",
            options: availableCatalogs.length > 0 ? availableCatalogs : ["All"],
            isRequired: false,
          },
        ],
      },
    ],
  };

  manifestCache = manifest;
  manifestCacheTime = now;
  return manifest;
}

// === CATALOG HANDLER ===
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log("Catalog request:", { type, id, extra });

  if (type !== "tv" || id !== "tvmux-main-catalog") {
    return { metas: [] };
  }

  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
  if (masterChannelList.length === 0) {
    return { metas: [] };
  }

  // Filter based on genre (which we use for source/country)
  const selectedGenre = extra?.genre;
  const filteredList =
    selectedGenre && selectedGenre !== "All"
      ? masterChannelList.filter(
          (c) => c.source === selectedGenre || c.country?.name === selectedGenre
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

// === META HANDLER ===
builder.defineMetaHandler(async ({ id }) => {
  console.log("Meta request for:", id);

  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
  const channel = masterChannelList.find((c) => c.id === id);

  if (!channel) {
    return { meta: null };
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

  return { meta };
});

// === STREAM HANDLER ===
builder.defineStreamHandler(async ({ id }) => {
  console.log("Stream request for:", id);

  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
  const channel = masterChannelList.find((c) => c.id === id);

  if (!channel || !channel.streams || channel.streams.length === 0) {
    return { streams: [] };
  }

  // Sort streams to put 'verified' ones first.
  const sortedStreams = [...channel.streams].sort((a, b) => {
    if (a.health === "verified" && b.health !== "verified") return -1;
    if (a.health !== "verified" && b.health === "verified") return 1;
    return 0;
  });

  const streams = sortedStreams.map((stream) => {
    const streamObj = {
      url: stream.url,
      title: `${
        stream.health === "verified"
          ? "✅"
          : stream.health === "failed"
          ? "❌"
          : "❔"
      } Verified Source`,
    };

    // Add headers if they exist
    if (stream.user_agent || stream.referrer) {
      streamObj.behaviorHints = {
        headers: {},
      };
      if (stream.user_agent) {
        streamObj.behaviorHints.headers["User-Agent"] = stream.user_agent;
      }
      if (stream.referrer) {
        streamObj.behaviorHints.headers["Referer"] = stream.referrer;
      }
    }

    return streamObj;
  });

  return { streams };
});

// This is the main serverless function entry point for Vercel
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", `public, max-age=${CACHE_MAX_AGE}`);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const pathname = url.pathname;

    console.log(`Request: ${req.method} ${pathname}`);

    // Handle manifest.json - use dynamic manifest
    if (pathname === "/manifest.json" || pathname === "/") {
      const manifest = await getDynamicManifest();
      return res.status(200).json(manifest);
    }

    // For all other routes, use the SDK's built-in router
    const addonInterface = builder.getInterface();

    // The SDK creates handlers in the 'get' object
    if (addonInterface.get && addonInterface.get[pathname]) {
      const handler = addonInterface.get[pathname];
      const query = Object.fromEntries(url.searchParams.entries());

      try {
        const result = await handler(query);
        return res.status(200).json(result);
      } catch (handlerError) {
        console.error("Handler error:", handlerError);
        return res.status(500).json({
          error: "Handler error",
          details: handlerError.message,
        });
      }
    }

    // If no handler found, return 404
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error("Main handler error:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
}
