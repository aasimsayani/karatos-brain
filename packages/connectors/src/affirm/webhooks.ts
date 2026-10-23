import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Affirm webhooks. Affirm sets them up itself, on request through its
 * support widget, and the events its docs describe are about checkouts and
 * prequalification, not settled money; Affirm doesn't resend a delivery that
 * fails. So a delivery is a prompt to sync, never data: the connector reads
 * the transactions on the next incremental pass, and nothing from the body
 * is kept.
 */

export type AffirmSignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: "missing" | "malformed" | "mismatch" | "stale" };

/** The header Affirm signs deliveries in. Its docs also call it X-Affirm-Signature; check whichever arrives. */
export const AFFIRM_SIGNATURE_HEADERS = ["affirm-signature", "x-affirm-signature"] as const;

/** The longest a signed delivery is trusted after its timestamp, as Affirm's docs suggest. */
export const AFFIRM_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const TIMESTAMP = /^\d{1,12}$/;
const HEX = /^[0-9a-f]{128}$/i;

/**
 * Checks Affirm's signature header: `t=<timestamp>` and one or more
 * `v0=<hex>` signatures, each the hex HMAC-SHA512 of `<timestamp>.<raw
 * body>` keyed with the endpoint's signing secret. Only the v0 scheme
 * counts, so a downgrade to another is refused, and signatures are
 * compared in constant time. A signature older or newer than the tolerance
 * is stale, so a captured delivery can't be replayed later. Check before
 * parsing the body, and answer anything but ok with a 401.
 */
export function verifyAffirmWebhook(
  signingSecret: string,
  rawBody: string | Buffer,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = AFFIRM_WEBHOOK_TOLERANCE_SECONDS,
): AffirmSignatureCheck {
  if (!signingSecret || !header) return { ok: false, reason: "missing" };
  let timestamp: string | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) return { ok: false, reason: "malformed" };
    const scheme = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (scheme === "t") {
      if (timestamp !== undefined || !TIMESTAMP.test(value)) return { ok: false, reason: "malformed" };
      timestamp = value;
    } else if (scheme === "v0") {
      if (!HEX.test(value)) return { ok: false, reason: "malformed" };
      signatures.push(Buffer.from(value, "hex"));
    }
    // Any other scheme is ignored, as Affirm's docs say, so it can't stand in for v0.
  }
  if (timestamp === undefined || signatures.length === 0) return { ok: false, reason: "malformed" };
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha512", signingSecret).update(`${timestamp}.`, "utf8").update(body).digest();
  if (!signatures.some((given) => given.length === expected.length && timingSafeEqual(given, expected))) return { ok: false, reason: "mismatch" };
  const t = Number(timestamp);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  return { ok: true, timestamp: t };
}
