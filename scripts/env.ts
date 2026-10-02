import { existsSync, readFileSync } from "node:fs";

/** process.env overlaid with .env.local, without printing anything. */
export function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match?.[1]) env[match[1]] = match[2]?.replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
