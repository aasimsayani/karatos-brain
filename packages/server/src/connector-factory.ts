import type { Connector, MemoryStore } from "@karatos/core";

/**
 * How a built connector is made from an instance's settings. Each connector
 * declares one in `packages/server/src/connectors/<id>.ts`, named after its
 * catalog id, and `npm run registry:write` lists them all for the runner.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** Where connectors that keep state of their own, like a rotating refresh token, keep it. */
export interface ConnectorStore {
  memory: MemoryStore;
  organizationId: string;
}

export interface ConnectorFactory {
  /** The settings it can't run without that this instance hasn't set, by name. */
  needs: (env: Env) => string[];
  make: (env: Env, store?: ConnectorStore) => Promise<Connector>;
}

/** A setting's value with surrounding space removed, or undefined when it is empty. */
export const setting = (env: Env, name: string) => (env[name]?.trim() ? env[name]!.trim() : undefined);

/** The named settings this instance hasn't set. */
export const missing = (env: Env, names: readonly string[]) => names.filter((name) => !setting(env, name));
