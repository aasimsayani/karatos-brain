import { z } from "zod";

/**
 * Settings for one deployed instance. An instance belongs to exactly one
 * client: it has its own organization id, API key and database, and never
 * serves another client's data.
 */
export const InstanceConfigSchema = z.object({
  INSTANCE_NAME: z.string().min(1),
  ORGANIZATION_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "use lowercase letters, digits and dashes, e.g. fuse-jewelry"),
  /** Shared secret callers send as "Authorization: Bearer <key>". */
  INSTANCE_API_KEY: z.string().min(32, "use at least 32 random characters, e.g. from: openssl rand -hex 32"),
  SUPABASE_DB_URL: z.string().startsWith("postgres"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Apply pending database migrations when the instance starts. */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Comma-separated ids of the source-of-truth docs reasoning must consult. */
  DOC_REGISTRY_IDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type InstanceConfig = z.infer<typeof InstanceConfigSchema>;

export function loadInstanceConfig(env: Record<string, string | undefined>): InstanceConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const result = InstanceConfigSchema.safeParse(cleaned);
  if (!result.success) {
    // Name the bad settings without echoing their values.
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid instance configuration: ${problems}`);
  }
  return result.data;
}
