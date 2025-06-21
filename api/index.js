/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers).
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe.
 */

import { addonBuilder, serveHTTP } from "stremio-addon-sdk";
import {
  getFromCache,
  MASTER_CHANNEL_LIST_KEY,
  AVAILABLE_CATALOGS_KEY,
} from "./_lib/cache.js";

const CACHE_MAX_AGE = 60 * 5; // 5 minutes in seconds

// This function now only builds the addon definition.
// It will be called once per serverless function invocation.
const buildAddon = async () => {
  const availableCatalogs = (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];
  const masterChannelList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];

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
            options: ["All", ...availableCatalogs],
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
  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log("Catalog request:", { type, id, extra });

    if (type !== "tv" || id !== "tvmux-main-catalog") {
      return Promise.resolve({ metas: [] });
    }

    if (masterChannelList.length === 0) {
      console.log("Master channel list is empty, returning empty catalog.");
      return Promise.resolve({ metas: [] });
    }

    const selectedGenre = extra?.genre;

    // Filter the list based on the selected genre.
    // A channel matches if its 'source' or 'country.name' matches the genre.
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
  builder.defineMetaHandler(async ({ id }) => {
    console.log("Meta request for:", id);

    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel) {
      console.warn(`Could not find meta for id: ${id}`);
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

  // STREAM HANDLER
  builder.defineStreamHandler(async ({ id }) => {
    console.log("Stream request for:", id);

    const channel = masterChannelList.find((c) => c.id === id);

    if (!channel || !channel.streams || channel.streams.length === 0) {
      console.warn(`No streams found for id: ${id}`);
      return Promise.resolve({ streams: [] });
    }

    // Sort streams to prioritize verified ones
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
      // Add behavior hints for headers if needed
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
};

// This is the addonInterface promise that will be resolved once.
const addonInterfacePromise = buildAddon();

/**
 * The main serverless function handler for Vercel.
 * This is now greatly simplified by using serveHTTP.
 */
export default async function handler(req, res) {
  // Set CORS and cache headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader(
    "Cache-Control",
    `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${
      CACHE_MAX_AGE * 2
    }`
  );

  // Handle pre-flight OPTIONS requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Forwards the request to the correct handler in the SDK
  try {
    const addonInterface = await addonInterfacePromise;
    serveHTTP(addonInterface, { req, res });
  } catch (err) {
    console.error("serveHTTP error:", err);
    res.writeHead(500);
    res.end(
      JSON.stringify({ error: "Internal Server Error", detail: err.message })
    );
  }
}
