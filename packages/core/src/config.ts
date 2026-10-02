import { z } from "zod";

/**
 * Runtime configuration. Only the database and core security settings are
 * required. Every business integration is optional so a shop can start with
 * whatever systems it already has.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ORGANIZATION_ID: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  MONDAY_API_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export const OPTIONAL_INTEGRATIONS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  shopify: ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ADMIN_ACCESS_TOKEN"],
  stripe: ["STRIPE_SECRET_KEY"],
  hubspot: ["HUBSPOT_ACCESS_TOKEN"],
  slack: ["SLACK_BOT_TOKEN"],
  monday: ["MONDAY_API_TOKEN"],
} as const satisfies Record<string, readonly (keyof Config)[]>;

export type IntegrationName = keyof typeof OPTIONAL_INTEGRATIONS;

export interface ConfigReport {
  ok: boolean;
  errors: string[];
  integrations: Record<IntegrationName, "configured" | "not_configured">;
}

/** Validates env without throwing and reports which integrations are set up. Never echoes values. */
export function checkConfig(env: Record<string, string | undefined>): ConfigReport {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = ConfigSchema.safeParse(cleaned);
  const integrations = Object.fromEntries(
    Object.entries(OPTIONAL_INTEGRATIONS).map(([name, keys]) => [
      name,
      keys.every((k) => cleaned[k] !== undefined) ? "configured" : "not_configured",
    ]),
  ) as ConfigReport["integrations"];

  return {
    ok: result.success,
    errors: result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    integrations,
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  return ConfigSchema.parse(cleaned);
}
