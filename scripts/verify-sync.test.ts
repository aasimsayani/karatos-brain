import { describe, expect, it } from "vitest";
import { parseVerifyArgs, renderVerification, requestVerification, verificationExitCode, VERIFY_CLI_TIMEOUT_MS, VerifyCliError, type VerifyCliReport } from "./verify-sync.js";

const KEY = ["instance", "key", "0".repeat(40)].join("-");
const base = ["--url", "https://brain.example.test/some/path?x=1", "--from", "2026-11-01", "--to", "2026-11-15"];

const report = (over: Partial<VerifyCliReport> = {}): VerifyCliReport => ({
  generatedAt: "2026-11-20T15:00:00.000Z",
  period: { startDay: "2026-11-01", endDay: "2026-11-15", timeZone: "America/New_York" },
  summary: { match: 1, mismatch: 1, unavailable: 1 },
  systems: [
    {
      system: "shopify",
      status: "mismatch",
      uncountedEvents: 2,
      metrics: [
        { metric: "sale_count", unit: "count", status: "mismatch", sourceTotal: 3, syncedTotal: 2, difference: -1, missing: { count: 21, sample: ["shopify:order:1003"] }, extra: { count: 0, sample: [] } },
        { metric: "gross_sales", unit: "cents", status: "mismatch", sourceTotal: 393_000, syncedTotal: 385_000, difference: -8_000, missing: { count: 1, sample: ["shopify:order:1003"] }, extra: { count: 1, sample: ["shopify:order:9"] }, amountDiffers: { count: 1, sample: ["shopify:order:1"] } },
      ],
    },
    { system: "stripe", status: "match", metrics: [{ metric: "charge_count", unit: "count", status: "match", sourceTotal: 3, syncedTotal: 3, difference: 0, missing: { count: 0, sample: [] }, extra: { count: 0, sample: [] } }] },
    { system: "klaviyo", status: "unavailable", reason: "klaviyo isn't turned on for this instance", metrics: [] },
  ],
  ...over,
});

describe("verify-sync arguments", () => {
  it("reads the instance, the days, the system and the tolerance, and calls only POST /v1/verify on the instance's origin", () => {
    const args = parseVerifyArgs([...base, "--system", "shopify", "--tolerance-cents", "5", "--json"]);
    expect(args).toEqual({ url: new URL("https://brain.example.test/v1/verify"), from: "2026-11-01", to: "2026-11-15", system: "shopify", toleranceCents: 5, json: true, timeoutMs: VERIFY_CLI_TIMEOUT_MS });
    expect(parseVerifyArgs(base)).toEqual({ url: new URL("https://brain.example.test/v1/verify"), from: "2026-11-01", to: "2026-11-15", json: false, timeoutMs: VERIFY_CLI_TIMEOUT_MS });
    expect(parseVerifyArgs(["--url", "http://localhost:8080", "--from", "2026-11-01", "--to", "2026-11-01"]).url.toString()).toBe("http://localhost:8080/v1/verify");
    expect(parseVerifyArgs(["--url", "http://127.0.0.1:8080", "--from", "2026-11-01", "--to", "2026-11-01"]).url.toString()).toBe("http://127.0.0.1:8080/v1/verify");
  });

  it("turns down what it can't use, naming the problem", () => {
    const bad = (argv: string[]) => {
      try {
        parseVerifyArgs(argv);
      } catch (error) {
        expect(error).toBeInstanceOf(VerifyCliError);
        return (error as Error).message;
      }
      return "accepted";
    };
    expect(bad(["--from", "2026-11-01", "--to", "2026-11-01"])).toBe("give --url, the instance's https address");
    expect(bad(["--url", "not a url", "--from", "2026-11-01", "--to", "2026-11-01"])).toBe("--url isn't a URL");
    expect(bad(["--url", "http://brain.example.test", "--from", "2026-11-01", "--to", "2026-11-01"])).toBe("--url must be https (http only for localhost)");
    expect(bad(["--url", "ftp://localhost", "--from", "2026-11-01", "--to", "2026-11-01"])).toBe("--url must be https (http only for localhost)");
    expect(bad(["--url", "https://user:pw@brain.example.test", "--from", "2026-11-01", "--to", "2026-11-01"])).toBe("--url can't carry a user name or password");
    expect(bad(["--url", "https://user@brain.example.test", "--from", "2026-11-01", "--to", "2026-11-01"])).toBe("--url can't carry a user name or password");
    expect(bad(["--url", "https://brain.example.test", "--from", "11/01/2026", "--to", "2026-11-01"])).toBe("give --from and --to as days, such as 2026-11-01");
    expect(bad(["--url", "https://brain.example.test", "--from", "2026-11-01"])).toBe("give --from and --to as days, such as 2026-11-01");
    expect(bad(["--url", "https://brain.example.test", "--to", "2026-11-01"])).toBe("give --from and --to as days, such as 2026-11-01");
    expect(bad(["--url", "https://brain.example.test", "--from", "2026-11-01", "--to", "2026-11-1"])).toBe("give --from and --to as days, such as 2026-11-01");
    expect(bad([...base, "--system", "Shopify"])).toBe("--system must be an integration id, such as shopify");
    expect(bad([...base, "--tolerance-cents", "1.5"])).toBe("--tolerance-cents must be a whole number of cents");
    expect(bad([...base, "--tolerance-cents", "1000"])).toBe("--tolerance-cents must be a whole number of cents");
    expect(bad([...base, "--system"])).toBe("--system needs a value");
    expect(bad([...base, "--system", "--json"])).toBe("--system needs a value");
    expect(bad([...base, "--key", "x"])).toBe("unknown option --key");
    expect(bad([...base, "extra"])).toBe("unknown option extra");
    expect(bad([...base, "--json", "extra"])).toBe("unknown option extra");
  });
});

describe("verify-sync request", () => {
  const args = parseVerifyArgs([...base, "--system", "shopify", "--tolerance-cents", "0"]);

  it("posts the period with the key, following no redirect", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.toString(), init });
      return Response.json({ verification: report() });
    }) as unknown as typeof fetch;
    expect(await requestVerification(args, ` ${KEY} `, fetcher)).toEqual(report());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://brain.example.test/v1/verify");
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({ from: "2026-11-01", to: "2026-11-15", system: "shopify", toleranceCents: 0 }) });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const plain = parseVerifyArgs(base);
    await requestVerification(plain, KEY, fetcher);
    expect(seen[1]!.init.body).toBe(JSON.stringify({ from: "2026-11-01", to: "2026-11-15" }));
  });

  it("says what went wrong without the key", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(requestVerification(args, " ", answer(200, {}))).rejects.toThrow("set INSTANCE_API_KEY to the instance's API key");
    await expect(requestVerification(args, KEY, answer(429, { error: "a sync verification is already running" }))).rejects.toThrow("the instance answered HTTP 429: a sync verification is already running");
    await expect(requestVerification(args, KEY, answer(302, ""))).rejects.toThrow(/^the instance answered HTTP 302$/);
    await expect(requestVerification(args, KEY, answer(200, { other: true }))).rejects.toThrow("the instance answered HTTP 200");
    await expect(requestVerification(args, KEY, answer(201, { verification: report() }))).rejects.toThrow("the instance answered HTTP 201");
    await expect(requestVerification(args, KEY, answer(403, { error: 7 }))).rejects.toThrow(/^the instance answered HTTP 403$/);
    const down = (async () => {
      throw new TypeError(`fetch failed for ${KEY}`);
    }) as unknown as typeof fetch;
    const error = (await requestVerification(args, KEY, down).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("the instance didn't answer (TypeError)");
    const odd = (async () => {
      throw "nope";
    }) as unknown as typeof fetch;
    await expect(requestVerification(args, KEY, odd)).rejects.toThrow("the instance didn't answer (network error)");
  });
});

describe("verify-sync report", () => {
  it("prints each system's figures, in dollars for money, with the ids that differ", () => {
    expect(renderVerification(report())).toBe(
      [
        "Sync verification, 2026-11-01 to 2026-11-15 (America/New_York): 1 match, 1 mismatch, 1 unavailable",
        "",
        "shopify: mismatch",
        "  sale_count: mismatch, source 3, synced 2, difference -1",
        "      missing 21: shopify:order:1003, ...",
        "  gross_sales: mismatch, source $3930.00, synced $3850.00, difference -$80.00",
        "      missing 1: shopify:order:1003",
        "      extra 1: shopify:order:9",
        "      amount differs 1: shopify:order:1",
        "  2 synced events couldn't be read, so the synced side is a floor",
        "stripe: match",
        "  charge_count: match, source 3, synced 3, difference 0",
        "klaviyo: unavailable (klaviyo isn't turned on for this instance)",
        "",
      ].join("\n"),
    );
    const partial = report({ systems: [{ system: "square", status: "unavailable", metrics: [{ metric: "sale_count", unit: "count", status: "unavailable", sourceTotal: null, syncedTotal: null, difference: null, missing: { count: 0, sample: [] }, extra: { count: 0, sample: [] }, reason: "too many" }] }] });
    expect(renderVerification(partial)).toContain("  sale_count: unavailable, source n/a, synced n/a, difference n/a (too many)");
  });

  it("exits 0 only when every system matches", () => {
    expect(verificationExitCode(report())).toBe(1);
    expect(verificationExitCode(report({ summary: { match: 2, mismatch: 0, unavailable: 0 } }))).toBe(0);
    expect(verificationExitCode(report({ summary: { match: 2, mismatch: 0, unavailable: 1 } }))).toBe(1);
    expect(verificationExitCode(report({ summary: { match: 2, mismatch: 1, unavailable: 0 } }))).toBe(1);
    expect(verificationExitCode(report({ summary: { match: 0, mismatch: 0, unavailable: 0 }, systems: [] }))).toBe(1);
  });
});
