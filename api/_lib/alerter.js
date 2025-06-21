/**
 * @file api/_lib/alerter.js
 * @description Webhook alerting logic for sending notifications on data source failures.
 * This module provides a simple, fire-and-forget function to send alerts
 * to a pre-configured webhook URL (e.g., Discord, Slack, Pipedream).
 */

import httpClient from "./httpClient.js";

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

/**
 * Sends an alert message to the configured webhook URL.
 * It logs errors to the console but does not throw them, ensuring that a
 * failure in the alerting system does not crash the main application logic.
 * * @param {string} sourceName - The name of the data source that failed (e.g., 'iptv-org', 'My Custom List').
 * @param {Error} error - The error object associated with the failure.
 */
export async function sendAlertToWebhook(sourceName, error) {
  if (!ALERT_WEBHOOK_URL) {
    console.warn("ALERT_WEBHOOK_URL is not configured. Skipping alert.");
    return;
  }

  const payload = {
    // Using Discord's embed format for a rich notification.
    embeds: [
      {
        title: "🚨 TVMux Data Source Failure",
        color: 15548997, // Red color
        fields: [
          { name: "Source", value: sourceName, inline: true },
          { name: "Timestamp", value: new Date().toISOString(), inline: true },
          { name: "Error Message", value: `\`\`\`${error.message}\`\`\`` },
          {
            name: "Error Stack",
            value: `\`\`\`${error.stack || "Not available"}\`\`\``,
          },
        ],
        footer: {
          text: "TVMux Background Worker",
        },
      },
    ],
  };

  try {
    // Use the hardened httpClient, but with a shorter timeout for alerts.
    await httpClient.post(ALERT_WEBHOOK_URL, payload, { timeout: 5000 });
    console.log(`Successfully sent alert for failed source: ${sourceName}`);
  } catch (alertError) {
    console.error(
      `Failed to send alert for source: ${sourceName}`,
      alertError.message
    );
  }
}
