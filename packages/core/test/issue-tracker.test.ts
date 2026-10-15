import { describe, expect, it } from "vitest";
import { changeMarker, gitHubIssueTracker } from "../src/index.js";

describe("gitHubIssueTracker", () => {
  function github(pages: unknown[][], created = 7) {
    const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") });
      if (String(url).includes("fail")) return new Response("{}", { status: 500 });
      if (method === "POST") return Response.json({ number: created }, { status: 201 });
      const page = Number(new URL(String(url)).searchParams.get("page"));
      return Response.json(pages[page - 1] ?? []);
    };
    return { fetch: fetch as typeof globalThis.fetch, calls };
  }

  it("finds an open issue by marker across pages, ignoring pull requests", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: i === 3 ? changeMarker("demo") : null, pull_request: i === 3 ? {} : undefined }));
    const { fetch, calls } = github([full, [{ number: 200, body: `x ${changeMarker("demo")}` }]]);
    const tracker = gitHubIssueTracker({ repo: "o/r", token: "t", labels: ["vendor-docs"], fetch });
    expect(await tracker.findOpen(changeMarker("demo"))).toEqual({ number: 200, body: `x ${changeMarker("demo")}` });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/issues?state=open&labels=vendor-docs&per_page=100&page=1",
      "https://api.github.com/repos/o/r/issues?state=open&labels=vendor-docs&per_page=100&page=2",
    ]);
    expect(calls[0]!.auth).toBe("Bearer t");
    expect(await gitHubIssueTracker({ repo: "o/r", token: "t", labels: ["vendor-docs"], fetch: github([[{ number: 1, body: null }]]).fetch }).findOpen("x")).toBeNull();
  });

  it("opens issues with labels and adds comments", async () => {
    const { fetch, calls } = github([]);
    const tracker = gitHubIssueTracker({ repo: "o/r", token: "t", labels: ["vendor-docs", "integration"], fetch });
    expect(await tracker.open("Title", "Body")).toBe(7);
    await tracker.comment(7, "Again");
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "https://api.github.com/repos/o/r/issues", { title: "Title", body: "Body", labels: ["vendor-docs", "integration"] }],
      ["POST", "https://api.github.com/repos/o/r/issues/7/comments", { body: "Again" }],
    ]);
  });

  it("surfaces GitHub errors", async () => {
    const tracker = gitHubIssueTracker({ repo: "fail/r", token: "t", labels: ["vendor-docs"], fetch: github([]).fetch });
    await expect(tracker.open("T", "B")).rejects.toThrow(/GitHub POST \/issues answered 500/);
  });
});
