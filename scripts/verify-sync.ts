/**
 * npm run verify-sync: asks one instance to check what it has synced against
 * the source systems' own totals (POST /v1/verify) and prints the result.
 * The instance key comes from the environment, never from a flag, so it
 * stays out of shell history, and it is sent only to that one route on the
 * instance's own host. See docs/verify-sync.md.
 */

export class VerifyCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyCliError";
  }
}

export interface VerifyCliArgs {
  url: URL;
  from: string;
  to: string;
  system?: string;
  toleranceCents?: number;
  json: boolean;
  timeoutMs: number;
}

export const VERIFY_CLI_USAGE = `npm run verify-sync -- --url <https://instance-host> --from YYYY-MM-DD --to YYYY-MM-DD [--system shopify] [--tolerance-cents 0] [--json]

The instance API key is read from INSTANCE_API_KEY. Both days are included and
are days on the store's own calendar. Exit 0: every system matches. 1: a
mismatch, or a system couldn't be verified. 2: the check couldn't run.`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SYSTEM = /^[a-z][a-z0-9_]{0,63}$/;
/** A whole run reads every system one after another, so it gets longer than one request usually would. */
export const VERIFY_CLI_TIMEOUT_MS = 10 * 60_000;

export function parseVerifyArgs(argv: readonly string[]): VerifyCliArgs {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    if (at < 0) return undefined;
    const v = argv[at + 1];
    if (v === undefined || v.startsWith("--")) throw new VerifyCliError(`${name} needs a value`);
    return v;
  };
  const known = new Set(["--url", "--from", "--to", "--system", "--tolerance-cents", "--json"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!known.has(a)) throw new VerifyCliError(`unknown option ${a.slice(0, 40)}`);
    if (a !== "--json") i++;
  }
  const rawUrl = value("--url");
  if (!rawUrl) throw new VerifyCliError("give --url, the instance's https address");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new VerifyCliError("--url isn't a URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new VerifyCliError("--url must be https (http only for localhost)");
  if (url.username || url.password) throw new VerifyCliError("--url can't carry a user name or password");
  const from = value("--from");
  const to = value("--to");
  if (!from || !DAY.test(from) || !to || !DAY.test(to)) throw new VerifyCliError("give --from and --to as days, such as 2026-11-01");
  const system = value("--system");
  if (system !== undefined && !SYSTEM.test(system)) throw new VerifyCliError("--system must be an integration id, such as shopify");
  const tolerance = value("--tolerance-cents");
  if (tolerance !== undefined && !/^\d{1,3}$/.test(tolerance)) throw new VerifyCliError("--tolerance-cents must be a whole number of cents");
  return {
    url: new URL("/v1/verify", url.origin),
    from,
    to,
    ...(system !== undefined ? { system } : {}),
    ...(tolerance !== undefined ? { toleranceCents: Number(tolerance) } : {}),
    json: argv.includes("--json"),
    timeoutMs: VERIFY_CLI_TIMEOUT_MS,
  };
}

interface Difference {
  count: number;
  sample: string[];
}

interface Metric {
  metric: string;
  unit: "count" | "cents";
  status: string;
  sourceTotal: number | null;
  syncedTotal: number | null;
  difference: number | null;
  missing: Difference;
  extra: Difference;
  amountDiffers?: Difference;
  reason?: string;
}

export interface VerifyCliReport {
  generatedAt: string;
  period: { startDay: string; endDay: string; timeZone: string };
  summary: { match: number; mismatch: number; unavailable: number };
  systems: { system: string; status: string; metrics: Metric[]; reason?: string; uncountedEvents?: number }[];
}

/** Calls the instance once. Follows no redirect, so the key never reaches another host. */
export async function requestVerification(args: VerifyCliArgs, key: string, fetcher: typeof fetch = fetch): Promise<VerifyCliReport> {
  if (!key.trim()) throw new VerifyCliError("set INSTANCE_API_KEY to the instance's API key");
  const body = { from: args.from, to: args.to, ...(args.system !== undefined ? { system: args.system } : {}), ...(args.toleranceCents !== undefined ? { toleranceCents: args.toleranceCents } : {}) };
  let response: Response;
  try {
    response = await fetcher(args.url, {
      method: "POST",
      headers: { authorization: `Bearer ${key.trim()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    throw new VerifyCliError(`the instance didn't answer (${error instanceof Error ? error.name : "network error"})`);
  }
  const parsed = (await response.json().catch(() => null)) as { verification?: VerifyCliReport; error?: unknown } | null;
  if (response.status !== 200 || !parsed?.verification) {
    const reason = typeof parsed?.error === "string" ? `: ${parsed.error.slice(0, 200)}` : "";
    throw new VerifyCliError(`the instance answered HTTP ${response.status}${reason}`);
  }
  return parsed.verification;
}

const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const figure = (m: Metric, n: number | null) => (n === null ? "n/a" : m.unit === "cents" ? dollars(n) : String(n));
const ids = (label: string, d: Difference | undefined) => (d && d.count ? [`      ${label} ${d.count}: ${d.sample.join(", ")}${d.count > d.sample.length ? ", ..." : ""}`] : []);

/** The short human-readable report. Ids only; the instance never sends names, contacts or payloads. */
export function renderVerification(report: VerifyCliReport): string {
  const { startDay, endDay, timeZone } = report.period;
  const { match, mismatch, unavailable } = report.summary;
  const lines = [`Sync verification, ${startDay} to ${endDay} (${timeZone}): ${match} match, ${mismatch} mismatch, ${unavailable} unavailable`, ""];
  for (const s of report.systems) {
    lines.push(`${s.system}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`);
    if (s.reason) continue;
    for (const m of s.metrics) {
      lines.push(`  ${m.metric}: ${m.status}, source ${figure(m, m.sourceTotal)}, synced ${figure(m, m.syncedTotal)}, difference ${figure(m, m.difference)}${m.reason ? ` (${m.reason})` : ""}`);
      lines.push(...ids("missing", m.missing), ...ids("extra", m.extra), ...ids("amount differs", m.amountDiffers));
    }
    if (s.uncountedEvents) lines.push(`  ${s.uncountedEvents} synced events couldn't be read, so the synced side is a floor`);
  }
  return `${lines.join("\n")}\n`;
}

/** 0 when every system matches, 1 otherwise. */
export const verificationExitCode = (report: VerifyCliReport) => (report.summary.mismatch === 0 && report.summary.unavailable === 0 && report.systems.length > 0 ? 0 : 1);
