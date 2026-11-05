import twilio from 'twilio';

/** Checks a webhook against the public URL Twilio was configured to call. */
export function isValidWebhook(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, unknown>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

/**
 * Checks the X-Twilio-Signature header on the Media Streams WebSocket upgrade.
 *
 * Twilio's docs require this check but don't state the exact signed URL for a
 * WebSocket, beyond suggesting a trailing slash. Every candidate below is a URL
 * we issued, so accepting any of them doesn't weaken the HMAC check.
 *
 * Returns the URL form that matched, so a real call shows which one Twilio uses,
 * or undefined if the signature is missing or wrong.
 */
export function matchWebSocketSignature(
  authToken: string,
  signature: string | undefined,
  publicBaseUrl: string,
  path: string,
): string | undefined {
  if (!signature) return undefined;

  const host = publicBaseUrl.replace(/^https:\/\//, '');
  const trimmedPath = path.replace(/\/$/, '');
  const candidates = [
    `wss://${host}${trimmedPath}`,
    `wss://${host}${trimmedPath}/`,
    `https://${host}${trimmedPath}`,
    `https://${host}${trimmedPath}/`,
  ];

  return candidates.find((url) => twilio.validateRequest(authToken, signature, url, {}));
}
