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

const builder = new addonBuilder({
  id: "com.tvmux.addon",
  version: "1.0.0",
  name: "TVMux",
  description: "Resilient IPTV addon sourcing from public and custom lists.",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  catalogs: [], // We will populate this dynamically
  idPrefixes: ["tvmux_"],
  behaviorHints: {
    configurable: true, // Indicates the addon has settings
    configurationRequired: false,
  },
});

// === MANIFEST HANDLER ===
// Dynamically builds the manifest with catalogs from the cache.
async function getManifest(config) {
  const now = Date.now();
  if (manifestCache && manifestCacheTime && now - manifestCacheTime < 300000) {
    // 5 min TTL
    return manifestCache;
  }

  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];

  const baseManifest = builder.getInterface();

  const manifest = {
    id: baseManifest.id,
    version: baseManifest.version,
    name: baseManifest.name,
    description: baseManifest.description,
    resources: baseManifest.resources,
    types: baseManifest.types,
    idPrefixes: baseManifest.idPrefixes,
    behaviorHints: baseManifest.behaviorHints,
    catalogs: [
      {
        type: "tv",
        id: "tvmux-main-catalog",
        name: "TVMux Channels",
        // Allow users to filter by the sources we found
        extra: [
          { name: "genre", options: availableCatalogs, isRequired: false },
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
    return Promise.resolve({ metas: [] });
  }

  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
  if (masterChannelList.length === 0) {
    return Promise.resolve({ metas: [] });
  }

  // Filter based on genre (which we use for source/country)
  const selectedGenre = extra.genre;
  const filteredList = selectedGenre
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

  return Promise.resolve({ metas });
});

// === META HANDLER ===
builder.defineMetaHandler(async ({ id }) => {
  console.log("Meta request for:", id);
  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
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
  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
  const channel = masterChannelList.find((c) => c.id === id);

  if (!channel || !channel.streams || channel.streams.length === 0) {
    return Promise.resolve({ streams: [] });
  }

  // Sort streams to put 'verified' ones first.
  const sortedStreams = [...channel.streams].sort((a, b) => {
    if (a.health === "verified" && b.health !== "verified") return -1;
    if (a.health !== "verified" && b.health === "verified") return 1;
    return 0;
  });

  const streams = sortedStreams.map((stream) => ({
    url: stream.url,
    // Add visual indicator for stream health
    title: `${
      stream.health === "verified"
        ? "✅"
        : stream.health === "failed"
        ? "❌"
        : "❔"
    } Verified Source`,
    behaviorHints: {
      // Provide headers if they exist
      headers: {
        "User-Agent": stream.user_agent,
        Referer: stream.referrer,
      },
      // notWebReady might be true for some streams, but we assume false by default
      notWebReady: false,
    },
  }));

  return Promise.resolve({ streams });
});

// Build the addon
const addonInterface = builder.getInterface();

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
    const searchParams = url.searchParams;

    console.log(`Request: ${req.method} ${pathname}`);

    // Handle manifest.json
    if (pathname === "/manifest.json" || pathname === "/") {
      const manifest = await getManifest();
      return res.status(200).json(manifest);
    }

    // Handle catalog requests
    if (pathname.startsWith("/catalog/")) {
      const pathParts = pathname.split("/");
      if (pathParts.length >= 4) {
        const type = pathParts[2];
        const id = pathParts[3];
        const extra = {};

        // Parse extra parameters
        for (const [key, value] of searchParams.entries()) {
          extra[key] = value;
        }

        const result = await builder.catalogHandler({ type, id, extra });
        return res.status(200).json(result);
      }
    }

    // Handle meta requests
    if (pathname.startsWith("/meta/")) {
      const pathParts = pathname.split("/");
      if (pathParts.length >= 4) {
        const type = pathParts[2];
        const id = pathParts[3];

        const result = await builder.metaHandler({ type, id });
        return res.status(200).json(result);
      }
    }

    // Handle stream requests
    if (pathname.startsWith("/stream/")) {
      const pathParts = pathname.split("/");
      if (pathParts.length >= 4) {
        const type = pathParts[2];
        const id = pathParts[3];

        const result = await builder.streamHandler({ type, id });
        return res.status(200).json(result);
      }
    }

    // Default: return 404
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    console.error("Handler error:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
}
