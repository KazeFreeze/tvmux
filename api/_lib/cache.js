/**
 * @file api/_lib/cache.js
 * @description Vercel KV (Redis) client wrapper.
 * This module abstracts the interaction with the Vercel KV store, providing
 * simple `get` and `set` functions for storing and retrieving the processed
 * channel data.
 */

import { kv } from "@vercel/kv";

export const MASTER_CHANNEL_LIST_KEY = "master_channel_list";
export const AVAILABLE_CATALOGS_KEY = "available_catalogs";

/**
 * Retrieves a value from the Vercel KV store by its key.
 * @param {string} key - The key of the item to retrieve.
 * @returns {Promise<any | null>} The parsed value, or null if not found or on error.
 */
export async function getFromCache(key) {
  try {
    const value = await kv.get(key);
    return value;
  } catch (error) {
    console.error(`Error getting key "${key}" from Vercel KV:`, error);
    return null;
  }
}

/**
 * Stores a value in the Vercel KV store. The value is automatically stringified.
 * @param {string} key - The key under which to store the value.
 * @param {any} value - The value to store.
 * @param {object} [options] - Optional settings, e.g., { ex: 86400 } for expiration in seconds.
 * @returns {Promise<void>}
 */
export async function setInCache(key, value, options = {}) {
  try {
    // Vercel KV client handles stringification automatically.
    // Set with a 24-hour expiration as a safeguard. The cron job will refresh it sooner.
    const defaultOptions = { ex: 86400 };
    await kv.set(key, value, { ...defaultOptions, ...options });
  } catch (error) {
    console.error(`Error setting key "${key}" in Vercel KV:`, error);
  }
}
