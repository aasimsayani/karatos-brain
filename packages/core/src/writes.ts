/**
 * Writing back to outside systems. Every connector starts read-only: it may
 * declare the write actions it could perform, but each one runs through a
 * WriteGate that refuses it unless the instance has turned writes on for that
 * integration and action. Every attempt, allowed or not, is audited.
 */
export interface WriteAction {
  /** Integration id from the catalog, e.g. "shopify". */
  integration: string;
  /** Action name within the integration, e.g. "adjust_inventory". */
  name: string;
  description: string;
}

/**
 * Which writes an instance allows, from ENABLED_WRITES entries such as
 * "shopify:adjust_inventory" or "shopify:*". Empty means read-only.
 */
export interface WritePolicy {
  allows(action: WriteAction): boolean;
}

const ENTRY = /^([a-z0-9_]+):([a-z0-9_]+|\*)$/;

/** Returns the entries that are not of the form integration:action or integration:*. */
export function invalidWriteEntries(entries: string[]): string[] {
  return entries.filter((entry) => !ENTRY.test(entry));
}

export function writePolicy(entries: string[]): WritePolicy {
  const invalid = invalidWriteEntries(entries);
  if (invalid.length > 0) throw new Error(`invalid write entries: ${invalid.join(", ")}`);
  const allowed = new Set(entries);
  return {
    allows: (action) => allowed.has(`${action.integration}:${action.name}`) || allowed.has(`${action.integration}:*`),
  };
}

export const READ_ONLY: WritePolicy = { allows: () => false };

export interface WriteAuditEntry {
  organizationId: string;
  integration: string;
  action: string;
  /** Who or what asked for the write, e.g. a user id or "recommendation:<id>". */
  requestedBy: string;
  outcome: "refused" | "performed" | "failed";
  at: string;
  error?: string;
}

export interface WriteAuditLog {
  recordWrite(entry: WriteAuditEntry): Promise<void>;
}

export class WritesDisabledError extends Error {
  constructor(readonly action: WriteAction) {
    super(`writes to ${action.integration} (${action.name}) are turned off for this instance`);
    this.name = "WritesDisabledError";
  }
}

export interface WriteGateOptions {
  organizationId: string;
  policy: WritePolicy;
  audit: WriteAuditLog;
  now?: () => Date;
}

export class WriteGate {
  private readonly now: () => Date;

  constructor(private readonly options: WriteGateOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Runs perform only if the policy allows the action; audits every attempt. */
  async run<T>(action: WriteAction, requestedBy: string, perform: () => Promise<T>): Promise<T> {
    const base = {
      organizationId: this.options.organizationId,
      integration: action.integration,
      action: action.name,
      requestedBy,
    };
    if (!this.options.policy.allows(action)) {
      await this.options.audit.recordWrite({ ...base, outcome: "refused", at: this.now().toISOString() });
      throw new WritesDisabledError(action);
    }
    try {
      const result = await perform();
      await this.options.audit.recordWrite({ ...base, outcome: "performed", at: this.now().toISOString() });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.audit.recordWrite({ ...base, outcome: "failed", at: this.now().toISOString(), error: message });
      throw error;
    }
  }
}

/** Keeps audit entries in memory, for tests and local use. */
export class InMemoryWriteAuditLog implements WriteAuditLog {
  readonly entries: WriteAuditEntry[] = [];

  async recordWrite(entry: WriteAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
