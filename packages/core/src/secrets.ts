import { z } from "zod";

/**
 * Secrets manifest: a value-free description of every secret and setting an
 * instance needs (secrets/manifest.json). Any person, script or AI agent can
 * read it to learn what to collect, where to get it, how to check it and
 * which values to generate instead of asking for them.
 */
export const SecretEntrySchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.enum(["secret", "config"]),
  description: z.string().min(1),
  requiredFor: z.array(z.string().regex(/^(core|instance|migrations|integration:[a-z_]+)$/)).min(1),
  pattern: z.string().optional(),
  example: z.string().optional(),
  generate: z.object({ method: z.enum(["random_hex", "random_base64url"]), bytes: z.number().int().min(16) }).optional(),
  howToGet: z.array(z.string()).min(1),
  docsUrl: z.string().optional(),
  rotateEveryDays: z.number().int().min(1).optional(),
  /** Never blocks readiness; the instance runs in a reduced mode without it. */
  optional: z.boolean().optional(),
});

export const SecretsManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(SecretEntrySchema),
});

export type SecretEntry = z.infer<typeof SecretEntrySchema>;
export type SecretsManifest = z.infer<typeof SecretsManifestSchema>;

export function parseManifest(input: unknown): SecretsManifest {
  const manifest = SecretsManifestSchema.parse(input);
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (seen.has(entry.name)) throw new Error(`duplicate manifest entry ${entry.name}`);
    seen.add(entry.name);
    if (entry.example && entry.pattern && entry.kind === "config" && !fullMatch(entry.pattern, entry.example)) {
      throw new Error(`example for ${entry.name} does not match its pattern`);
    }
  }
  return manifest;
}

export type SecretStatus = "ok" | "missing" | "invalid" | "will_generate" | "not_needed";

export interface SecretPlanItem {
  name: string;
  kind: SecretEntry["kind"];
  required: boolean;
  status: SecretStatus;
  description: string;
  howToGet: string[];
  docsUrl?: string;
}

export interface SecretPlan {
  ready: boolean;
  items: SecretPlanItem[];
}

export interface PlanOptions {
  /** Purposes in play, e.g. ["core", "instance"]. */
  purposes: string[];
  /** Integrations turned on, e.g. ["shopify"]. */
  integrations: string[];
}

function fullMatch(pattern: string, value: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(value);
}

export function isRequired(entry: SecretEntry, options: PlanOptions): boolean {
  return !entry.optional && entry.requiredFor.some((purpose) =>
    purpose.startsWith("integration:")
      ? options.integrations.includes(purpose.slice("integration:".length))
      : options.purposes.includes(purpose),
  );
}

/**
 * Works out what is still needed. Never includes values, so the plan is safe
 * to print, log or hand to another agent.
 */
export function planSecrets(manifest: SecretsManifest, env: Record<string, string | undefined>, options: PlanOptions): SecretPlan {
  const items = manifest.entries.map((entry): SecretPlanItem => {
    const required = isRequired(entry, options);
    const value = env[entry.name];
    let status: SecretStatus;
    if (value !== undefined && value !== "") {
      status = entry.pattern && !fullMatch(entry.pattern, value) ? "invalid" : "ok";
    } else if (!required) {
      status = "not_needed";
    } else {
      status = entry.generate ? "will_generate" : "missing";
    }
    return {
      name: entry.name,
      kind: entry.kind,
      required,
      status,
      description: entry.description,
      howToGet: entry.howToGet,
      ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    };
  });
  const ready = items.every((i) => i.status === "ok" || i.status === "not_needed" || i.status === "will_generate");
  return { ready, items };
}

/** Fresh random value for an entry that declares a generate method. */
export function generateSecret(entry: SecretEntry, randomBytes: (n: number) => Uint8Array): string {
  if (!entry.generate) throw new Error(`${entry.name} cannot be generated`);
  const bytes = Buffer.from(randomBytes(entry.generate.bytes));
  return entry.generate.method === "random_hex" ? bytes.toString("hex") : bytes.toString("base64url");
}

/** Shows enough of a secret to recognise it, and no more. */
export function redact(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}
