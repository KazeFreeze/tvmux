/**
 * @file api/index.js
 * @description The User-Facing API (Stremio Handlers) - OPTIMIZED VERSION
 * This serverless function responds to requests from the Stremio application.
 * It is architected to be stateless and serverless-safe with performance optimizations.
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
 * This function builds the FULL addon interface, required for the SDK's internal router
 * to handle catalog, meta, and stream requests correctly.
 * @returns {Promise<object>} A promise resolving to a Stremio addon instance.
 */
async function getAddon() {
  console.log("GETADDON: Starting full addon creation...");

  const builder = new addonBuilder({
    id: "com.tvmux.addon",
    version: "1.0.10", // Bump version for performance optimizations
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
            // This is required for the SDK to know how to handle genre filtering
            // when the user is browsing the catalog.
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
  console.log("GETADDON: Full addon builder configured.");

  // CATALOG HANDLER - OPTIMIZED
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
    let channelList = [];
    const MAX_CHANNELS_PER_REQUEST = 50; // Limit to prevent timeouts

    if (selectedGenre && selectedGenre !== "All") {
      // FAST PATH: Use pre-cached genre-specific channels
      const cacheKey = `catalog_${selectedGenre}`;
      console.log(`CATALOG HANDLER: FAST PATH. Key: '${cacheKey}'`);
      channelList = (await getFromCache(cacheKey)) || [];

      // Limit the number of channels returned
      if (channelList.length > MAX_CHANNELS_PER_REQUEST) {
        channelList = channelList.slice(0, MAX_CHANNELS_PER_REQUEST);
        console.log(
          `CATALOG HANDLER: Limited to ${MAX_CHANNELS_PER_REQUEST} channels for performance`
        );
      }
    } else {
      // OPTIMIZED DEFAULT PATH: Get available catalogs and show a sample from each
      console.log(
        `CATALOG HANDLER: OPTIMIZED DEFAULT PATH. Getting sample from all catalogs.`
      );

      try {
        const availableCatalogs =
          (await getFromCache(AVAILABLE_CATALOGS_KEY)) || [];
        console.log(`Found ${availableCatalogs.length} available catalogs`);

        if (availableCatalogs.length === 0) {
          console.warn(
            "No available catalogs found, falling back to master list sample"
          );
          const masterList =
            (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
          channelList = masterList.slice(0, MAX_CHANNELS_PER_REQUEST);
        } else {
          // Get a small sample from each catalog (up to 10 channels per catalog)
          const channelsPerCatalog = Math.max(
            1,
            Math.floor(MAX_CHANNELS_PER_REQUEST / availableCatalogs.length)
          );
          const samplePromises = availableCatalogs
            .slice(0, 10)
            .map(async (catalog) => {
              // Limit to 10 catalogs
              const cacheKey = `catalog_${catalog}`;
              const catalogChannels = (await getFromCache(cacheKey)) || [];
              return catalogChannels.slice(0, channelsPerCatalog);
            });

          const catalogSamples = await Promise.all(samplePromises);
          channelList = catalogSamples.flat();
          console.log(
            `Assembled ${channelList.length} channels from ${catalogSamples.length} catalogs`
          );
        }
      } catch (error) {
        console.error("Error in optimized default path:", error);
        // Emergency fallback - get a small sample from master list
        const masterList = (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
        channelList = masterList.slice(0, MAX_CHANNELS_PER_REQUEST);
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

    // Convert channels to metas format
    const metas = channelList.map((channel) => ({
      id: channel.id,
      type: "tv",
      name: channel.name,
      poster: channel.logo,
      posterShape: "square",
      // Add genre information for better filtering
      genres: channel.categories ? channel.categories.slice(0, 3) : undefined,
    }));

    console.log(
      `CATALOG HANDLER: Responding with ${metas.length} metas. Total time: ${
        Date.now() - requestStartTime
      }ms.`
    );
    return Promise.resolve({ metas });
  });

  // META HANDLER - OPTIMIZED
  builder.defineMetaHandler(async (args) => {
    const requestStartTime = Date.now();
    console.log(`META HANDLER: Looking up channel ID: ${args.id}`);

    try {
      const masterChannelList =
        (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
      const channel = masterChannelList.find((c) => c.id === args.id);

      if (!channel) {
        console.warn(`META HANDLER: Channel not found: ${args.id}`);
        return Promise.resolve({ meta: null });
      }

      const meta = {
        id: channel.id,
        type: "tv",
        name: channel.name,
        poster: channel.logo,
        posterShape: "square",
        // Add additional metadata
        genres: channel.categories || [],
        description: `${channel.name} from ${channel.source}${
          channel.country?.name ? ` (${channel.country.name})` : ""
        }`,
      };

      console.log(
        `META HANDLER: Found metadata in ${Date.now() - requestStartTime}ms`
      );
      return Promise.resolve({ meta });
    } catch (error) {
      console.error("META HANDLER: Error fetching metadata:", error);
      return Promise.resolve({ meta: null });
    }
  });

  // STREAM HANDLER - OPTIMIZED
  builder.defineStreamHandler(async (args) => {
    const requestStartTime = Date.now();
    console.log(
      `STREAM HANDLER: Looking up streams for channel ID: ${args.id}`
    );

    try {
      const masterChannelList =
        (await getFromCache(MASTER_CHANNEL_LIST_KEY)) || [];
      const channel = masterChannelList.find((c) => c.id === args.id);

      if (!channel || !channel.streams || channel.streams.length === 0) {
        console.warn(
          `STREAM HANDLER: No streams found for channel: ${args.id}`
        );
        return Promise.resolve({ streams: [] });
      }

      // Sort streams by health status (verified first)
      const sortedStreams = [...channel.streams].sort((a, b) => {
        if (a.health === "verified" && b.health !== "verified") return -1;
        if (b.health === "verified" && a.health !== "verified") return 1;
        return 0;
      });

      const streams = sortedStreams.map((stream, index) => {
        let title = "📺 Stream";
        if (stream.health === "verified") {
          title = "✅ Verified Stream";
        } else if (stream.health === "failed") {
          title = "⚠️ Unverified Stream";
        } else if (stream.quality) {
          title = `📺 ${stream.quality} Stream`;
        }

        // Add stream index if multiple streams
        if (sortedStreams.length > 1) {
          title += ` (${index + 1})`;
        }

        const streamObj = {
          url: stream.url,
          title,
        };

        // Add headers if available
        if (stream.user_agent || stream.referrer) {
          streamObj.behaviorHints = {
            notWebReady: true,
          };
        }

        return streamObj;
      });

      console.log(
        `STREAM HANDLER: Returning ${streams.length} streams in ${
          Date.now() - requestStartTime
        }ms`
      );
      return Promise.resolve({ streams });
    } catch (error) {
      console.error("STREAM HANDLER: Error fetching streams:", error);
      return Promise.resolve({ streams: [] });
    }
  });

  console.log("GETADDON: Full handlers defined. Returning interface.");
  return builder.getInterface();
}

/**
 * The main serverless function handler for Vercel.
 */
export default async function handler(req, res) {
  const handlerStartTime = Date.now();
  console.log(`HANDLER: Function handler started for URL: ${req.url}`);

  // Set CORS headers for all responses
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // FIX: Bypass the SDK for the manifest request to avoid timeouts.
  // We serve a lightweight, simplified manifest manually for fast installation.
  if (req.url === "/manifest.json" || req.url === "/") {
    console.log(
      "HANDLER: Bypassing SDK and serving lightweight manifest directly."
    );
    const lightweightManifest = {
      id: "com.tvmux.addon",
      version: "1.0.10",
      name: "TVMux",
      description:
        "Resilient IPTV addon sourcing from public and custom lists.",
      resources: ["catalog", "meta", "stream"],
      types: ["tv"],
      catalogs: [
        {
          type: "tv",
          id: "tvmux-main-catalog",
          name: "TVMux Channels",
          // Restore 'extra' to re-enable the genre search/filter input in Stremio.
          extra: [{ name: "genre" }],
        },
      ],
      idPrefixes: ["tvmux_"],
      behaviorHints: {
        configurable: true,
        configurationRequired: false,
      },
    };

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(lightweightManifest));
    console.log(
      `HANDLER: Lightweight manifest served in ${
        Date.now() - handlerStartTime
      }ms.`
    );
    return;
  }

  // For all other requests (catalog, meta, stream), use the full SDK with timeout protection
  try {
    // Add a timeout wrapper to prevent hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("Handler timeout after 50 seconds")),
        50000
      );
    });

    const addonPromise = getAddon().then((addonInterface) => {
      return new Promise((resolve, reject) => {
        // Wrap serveHTTP in a promise to handle it properly
        try {
          serveHTTP(addonInterface, { req, res });
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    await Promise.race([addonPromise, timeoutPromise]);

    console.log(
      `HANDLER: Request completed in ${Date.now() - handlerStartTime}ms.`
    );
  } catch (err) {
    console.error(
      "HANDLER: A critical error occurred during request processing.",
      err
    );

    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Internal Server Error during request processing.",
          detail: err.message,
        })
      );
    }
  }
}
