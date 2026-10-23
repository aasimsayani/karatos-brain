import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { Connector } from "@karatos/core";
import { scheduledConnectors, type ConnectorStore } from "../src/index.js";

/**
 * Shared steps for the per-connector tests in ./connectors/<id>.test.ts. Each
 * built connector's factory has a test file there, named after its catalog id.
 */

export const ORG = "test-jeweler";

// Assembled at runtime so no key-shaped string sits in the repository.
export const fakeKey = (kind: "rk" | "sk", mode: "test" | "live") => [kind, mode, "0".repeat(24)].join("_");

/** An empty folder for a file-based connector to read. */
export const emptyFolder = (name: string) => mkdtemp(join(tmpdir(), `sync-${name}-`));

/** Why the runner skips this connector with these settings, or null when it schedules it. */
export function skipReason(id: string, env: Record<string, string>): string | null {
  const { skipped } = scheduledConnectors([id], env);
  return skipped.find((s) => s.id === id)?.reason ?? null;
}

/** Builds the connector the way the runner does, and checks it is the one asked for and read-only. */
export async function buildsFromSettings(id: string, env: Record<string, string>, store?: ConnectorStore): Promise<Connector> {
  const { connectors, skipped } = scheduledConnectors([id], env, store);
  expect(skipped).toEqual([]);
  const connector = await connectors[0]!.make();
  expect(connector.source).toBe(id);
  expect(connector).not.toHaveProperty("write");
  return connector;
}
