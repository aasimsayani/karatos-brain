import { createHmac } from "node:crypto";

/** HMAC-SHA256 of a raw webhook body, the way most vendors sign deliveries. */
export function hmacSha256(secret: string, body: string, encoding: "hex" | "base64" = "hex"): string {
  return createHmac("sha256", secret).update(body, "utf8").digest(encoding);
}

/**
 * A signed delivery with a timestamped signature header (`t=<unix>,v1=<hex>`,
 * signing `<t>.<body>`), the scheme Stripe and others use. Tests feed it to a
 * connector's verifier, then tamper with it to check rejection.
 */
export function timestampedSignature(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${hmacSha256(secret, `${unixSeconds}.${body}`)}`;
}

/** The same delivery with one byte of the body changed, for negative tests. */
export function tamper(body: string): string {
  if (body.length === 0) return " ";
  const last = body.charCodeAt(body.length - 1);
  return body.slice(0, -1) + String.fromCharCode(last === 0x7a ? 0x79 : last + 1);
}
