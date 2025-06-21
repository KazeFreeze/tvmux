/**
 * @file api/_lib/httpClient.js
 * @description Hardened Axios HTTP client for all external requests.
 * This module exports a pre-configured axios instance that enforces timeouts,
 * content length limits, and other best practices to prevent the application
 * from hanging on slow or malicious external resources.
 */

import axios from "axios";

// Create a new axios instance with hardened configurations.
const httpClient = axios.create({
  // Set a default timeout of 10 seconds for all requests.
  timeout: 10000,

  // Set a maximum response content length of 10MB to prevent memory abuse.
  maxContentLength: 10485760,

  // Disable following redirects. This is a security measure to ensure
  // we are only interacting with the intended endpoint.
  maxRedirects: 0,

  // Define a validateStatus function to control which HTTP status codes
  // should be considered a success. Here, only 2xx codes are successful.
  validateStatus: function (status) {
    return status >= 200 && status < 300;
  },
});

export default httpClient;
