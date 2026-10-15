import { runSync, type Connector, type SourceBatch, type SyncContext, type SyncReport } from "./connectors.js";
import type { IssueTracker } from "./issue-tracker.js";
import { InMemoryStore } from "./memory.js";
import { BrainPipeline, DeadLetteredError } from "./pipeline.js";

/**
 * Nightly sandbox run: every built connector runs against its vendor's own
 * sandbox (a historical import, an incremental sync and, where the vendor can
 * send one, a test webhook) into a throwaway in-memory store. A failure opens
 * one issue naming the connector and the step. Connectors whose sandbox
 * credentials aren't configured are skipped and listed, never failed.
 */

export type SandboxStep = "historical" | "incremental" | "webhook";

export interface SandboxCheck {
  integration: string;
  name: string;
  /** Names of the test-only sandbox credentials, read from the environment. */
  credentials: string[];
  connector(credentials: Record<string, string>): Connector;
  /** Asks the sandbox to send a test delivery and returns the verified body. */
  webhook?(credentials: Record<string, string>): Promise<unknown>;
  /** Records the seeded sandbox is known to hold. Fewer means data went missing. */
  minimumEvents?: number;
}

export interface SandboxStepReport {
  step: SandboxStep;
  report?: SyncReport;
  webhookEvents?: number;
}

export type SandboxResult =
  | { integration: string; status: "passed"; steps: SandboxStepReport[]; closed: number[]; issueError?: string }
  | { integration: string; status: "failed"; step: SandboxStep; error: string; issue?: number; issueError?: string }
  | { integration: string; status: "skipped"; missing: string[] };

export interface SandboxRunOptions {
  checks: readonly SandboxCheck[];
  env: Readonly<Record<string, string | undefined>>;
  issues: IssueTracker;
  /** Stops each import after this many batches so a large sandbox can't run all night. */
  maxBatches?: number;
  now?: () => Date;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const sandboxMarker = (integration: string, step: SandboxStep) => `<!-- sandbox-run:${integration}:${step} -->`;

const STEPS: SandboxStep[] = ["historical", "incremental", "webhook"];

/** Wraps a connector so each sync stops after `max` batches. */
export function limitBatches(connector: Connector, max: number): Connector {
  const limit = (pages: (context: SyncContext) => AsyncIterable<SourceBatch>) =>
    async function* (context: SyncContext): AsyncIterable<SourceBatch> {
      if (max <= 0) return;
      let n = 0;
      for await (const batch of pages(context)) {
        yield batch;
        if (++n >= max) return;
      }
    };
  return {
    ...connector,
    historicalImport: limit((c) => connector.historicalImport(c)),
    incrementalSync: limit((c) => connector.incrementalSync(c)),
  };
}

class StepFailure extends Error {
  constructor(
    readonly step: SandboxStep,
    message: string,
  ) {
    super(message);
  }
}

function describe(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e instanceof Error && parts.length < 4; e = e.cause) parts.push(e.message);
  return parts.join(": ") || String(error);
}

async function runCheck(check: SandboxCheck, credentials: Record<string, string>, options: SandboxRunOptions) {
  const memory = new InMemoryStore();
  const pipeline = new BrainPipeline({
    memory,
    normalizers: [],
    extractors: [],
    reasoners: [],
    documentation: { current: () => ({ documentIds: [], stale: false }) },
  });
  const organizationId = "sandbox";
  const steps: SandboxStepReport[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const sync = async (step: "historical" | "incremental") => {
    let connector: Connector;
    try {
      connector = limitBatches(check.connector(credentials), options.maxBatches ?? 20);
    } catch (error) {
      throw new StepFailure(step, `could not build the connector: ${describe(error)}`);
    }
    let report: SyncReport;
    try {
      report = await runSync({ connector, mode: step, pipeline, memory, organizationId, sleep });
    } catch (error) {
      throw new StepFailure(step, describe(error));
    }
    steps.push({ step, report });
    if (report.deadLettered > 0) {
      throw new StepFailure(step, `${report.deadLettered} records failed validation; the vendor's payloads may have changed`);
    }
    return report;
  };

  const historical = await sync("historical");
  const seen = historical.ingested + historical.duplicates;
  if (check.minimumEvents !== undefined && seen < check.minimumEvents) {
    throw new StepFailure("historical", `imported ${seen} records, expected at least ${check.minimumEvents} from the seeded sandbox`);
  }
  await sync("incremental");

  if (check.webhook) {
    const connector = check.connector(credentials);
    if (!connector.handleWebhook) throw new StepFailure("webhook", "the check sends a webhook but the connector can't handle one");
    let events: unknown[];
    try {
      events = connector.handleWebhook(await check.webhook(credentials));
    } catch (error) {
      throw new StepFailure("webhook", describe(error));
    }
    if (events.length === 0) throw new StepFailure("webhook", "the test delivery produced no events");
    for (const raw of events) {
      const event = typeof raw === "object" && raw !== null ? { ...raw, organizationId, source: connector.source } : raw;
      try {
        await pipeline.ingest(event);
      } catch (error) {
        if (error instanceof DeadLetteredError) throw new StepFailure("webhook", "the test delivery failed validation");
        throw new StepFailure("webhook", describe(error));
      }
    }
    steps.push({ step: "webhook", webhookEvents: events.length });
  }
  return steps;
}

async function fileFailure(check: SandboxCheck, failure: StepFailure, issues: IssueTracker, at: string): Promise<number> {
  const marker = sandboxMarker(check.integration, failure.step);
  const open = await issues.findOpen(marker);
  if (open) return open.number;
  const fenceSafe = failure.message.replaceAll("```", "'''");
  return issues.open(
    `Sandbox run failed: ${check.name}, ${failure.step} step`,
    [
      marker,
      `The nightly sandbox run of the ${check.name} connector failed at the **${failure.step}** step on ${at}.`,
      "",
      "```text",
      fenceSafe,
      "```",
      "",
      "**To do**",
      "- [ ] Reproduce it locally against the sandbox",
      "- [ ] If the vendor changed something, check the vendor docs watch issues and the vendor's changelog",
      "- [ ] Fix it with a test that fails without the fix",
      "- [ ] If the vendor broke a documented behavior, write it up in the runbook's vendor-issues",
      "",
      "Opened by the nightly sandbox run, which closes it once the connector passes again.",
    ].join("\n"),
  );
}

/** Closes the failure issues of a connector that passes again. Returns the issues closed. */
async function closeRecovered(check: SandboxCheck, issues: IssueTracker, at: string): Promise<number[]> {
  const closed: number[] = [];
  for (const step of STEPS) {
    const open = await issues.findOpen(sandboxMarker(check.integration, step));
    if (open) {
      await issues.close(open.number, `Passing again in the sandbox run on ${at}. Closing; a new failure opens a new issue.`);
      closed.push(open.number);
    }
  }
  return closed;
}

/** Runs every check once. One connector failing never stops the others. */
export async function runSandboxChecks(options: SandboxRunOptions): Promise<SandboxResult[]> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const results: SandboxResult[] = [];
  for (const check of options.checks) {
    const missing = check.credentials.filter((name) => !options.env[name]);
    if (missing.length > 0) {
      results.push({ integration: check.integration, status: "skipped", missing });
      continue;
    }
    const credentials = Object.fromEntries(check.credentials.map((name) => [name, options.env[name]!]));
    let steps: SandboxStepReport[] = [];
    let failure: StepFailure | null = null;
    try {
      steps = await runCheck(check, credentials, options);
    } catch (error) {
      failure = error instanceof StepFailure ? error : new StepFailure("historical", describe(error));
    }
    // Filing is kept apart from running, so a GitHub outage is never reported as a connector failure.
    if (failure) {
      const base = { integration: check.integration, status: "failed" as const, step: failure.step, error: failure.message };
      try {
        results.push({ ...base, issue: await fileFailure(check, failure, options.issues, at) });
      } catch (error) {
        results.push({ ...base, issueError: describe(error) });
      }
    } else {
      try {
        results.push({ integration: check.integration, status: "passed", steps, closed: await closeRecovered(check, options.issues, at) });
      } catch (error) {
        results.push({ integration: check.integration, status: "passed", steps, closed: [], issueError: describe(error) });
      }
    }
  }
  return results;
}
