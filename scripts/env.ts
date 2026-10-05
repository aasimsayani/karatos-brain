import { existsSync, readFileSync } from "node:fs";

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1]) env[match[1]] = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

/** Sets keys in an env file's text, keeping comments, order and untouched lines. */
export function upsertEnvFile(text: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text.split("\n").map((line) => {
    const key = line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1];
    if (key && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  if (lines.length && lines.at(-1) === "") lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

/** process.env overlaid with an env file (default .env.local), without printing anything. */
export function loadEnv(path = ".env.local"): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (existsSync(path)) Object.assign(env, parseEnvFile(readFileSync(path, "utf8")));
  return env;
}
