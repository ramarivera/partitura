import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Redacted } from "effect";
import { isString } from "./linear-helpers.js";

export const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isString);

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

export const verifySignature = (
  rawBody: Uint8Array,
  signature: string,
  secret: Redacted.Redacted<string>,
): boolean => {
  try {
    const expected = createHmac("sha256", Redacted.value(secret))
      .update(rawBody)
      .digest("hex");
    const normalized = signature.toLowerCase();
    if (expected.length !== normalized.length) return false;
    const a = Buffer.from(expected, "utf-8");
    const b = Buffer.from(normalized, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

export const payloadHash = (rawBody: Uint8Array): string =>
  createHash("sha256").update(rawBody).digest("hex");

// Linear reports the OAuth client id in two forms: the console client_id
// (hex, used by the OAuth flow) in AgentSessionEvent payloads, and the
// dashed-UUID form of the same client in PermissionChange payloads. Compare
// normalized forms; the client id is an identifier, not a secret.
export const normalizeClientId = (value: string): string =>
  value.replaceAll("-", "").toLowerCase();

export const clientIdMatches = (
  received: string,
  configured: string,
): boolean => normalizeClientId(received) === normalizeClientId(configured);

export const buildFallbackDeliveryId = (
  parsed: Record<string, unknown>,
  timestamp: number,
): string => {
  const webhookId = isString(parsed.webhookId) ? parsed.webhookId : "unknown";
  const action = isString(parsed.action) ? parsed.action : "unknown";
  const organizationId = isString(parsed.organizationId)
    ? parsed.organizationId
    : "unknown";
  return `linear:${webhookId}:${timestamp}:${action}:${organizationId}`;
};
