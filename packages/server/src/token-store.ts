import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { MemoryStore } from "@karatos/core";

/**
 * Keeps a rotating OAuth refresh token in the instance's database, encrypted.
 * QuickBooks hands out a new refresh token about once a day and only the
 * newest is sure to work, so the one in the host's secret store goes stale;
 * the newest has to live somewhere the instance can write.
 *
 * The token is sealed with AES-256-GCM under a key derived from the app's
 * client secret, so a copy of the database alone can't use it. The secret
 * store's token is the seed: if someone replaces it there (after
 * reconnecting the company), the new seed wins over the stored token. If the
 * stored token can't be read, because the client secret was rotated or the
 * row was tampered with, the seed is used again.
 */

const VERSION = 1;

export interface SealedTokenStoreOptions {
  memory: MemoryStore;
  organizationId: string;
  /** The integration whose token this is, e.g. "quickbooks". */
  source: string;
  /** The refresh token from the host's secret store. */
  seed: string;
  /** Secret material the encryption key is derived from: the app's client secret. */
  keyMaterial: string;
}

/** The checkpoint stream the sealed token is kept under. */
export const REFRESH_TOKEN_STREAM = "oauth_refresh_token";

interface Sealed {
  v: number;
  /** Which seed this token descends from, as a short hash. */
  seed: string;
  iv: string;
  tag: string;
  data: string;
}

const fingerprint = (seed: string) => createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);

export function sealedTokenStore(options: SealedTokenStoreOptions) {
  const seed = options.seed.trim();
  if (!seed) throw new Error("a refresh token store needs a seed token");
  if (options.keyMaterial.trim().length < 16) throw new Error("a refresh token store needs the client secret to derive its key");
  const key = Buffer.from(hkdfSync("sha256", options.keyMaterial, `karatos:${options.organizationId}`, `${options.source} refresh token v${VERSION}`, 32));
  const seedId = fingerprint(seed);
  // The organization and seed are bound in as associated data, so a sealed token can't be moved to another instance or seed.
  const aad = Buffer.from(`${options.organizationId}:${options.source}:${seedId}`, "utf8");
  const read = () => options.memory.getCheckpoint(options.organizationId, options.source, REFRESH_TOKEN_STREAM);

  return {
    async load(): Promise<string> {
      const raw = await read();
      if (!raw) return seed;
      try {
        const sealed = JSON.parse(raw) as Sealed;
        if (sealed.v !== VERSION || sealed.seed !== seedId) return seed;
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
        decipher.setAAD(aad);
        decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
        const token = Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
        return token || seed;
      } catch {
        return seed;
      }
    },
    async save(token: string): Promise<void> {
      if (!token.trim()) return;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
      const sealed: Sealed = { v: VERSION, seed: seedId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
      await options.memory.saveCheckpoint(options.organizationId, options.source, REFRESH_TOKEN_STREAM, JSON.stringify(sealed));
    },
  };
}
