import type { FormAnswer, FormSubmission } from "./normalize.js";

/**
 * A small, read-only client for Typeform's Create and Responses APIs. It
 * sends GET requests for two things only, a form's definition and its
 * responses, with parameters it checks itself, to one of Typeform's three
 * API hosts. A personal access token should hold only forms:read and
 * responses:read. Typeform has no way to look up a token's scopes, so the
 * client can't refuse a token with more; the allowlist is the guard.
 *
 * Typeform allows two requests a second per account across the Create and
 * Responses APIs, so requests are spaced at least half a second apart, and
 * a 429 is waited out and retried.
 */

/** The US host, the EU host and the newer EU data center, which keeps its own accounts and tokens. */
export const TYPEFORM_HOSTS = ["api.typeform.com", "api.eu.typeform.com", "api.typeform.eu"] as const;
export type TypeformHost = (typeof TYPEFORM_HOSTS)[number];

/** Typeform's largest page of responses. */
export const TYPEFORM_PAGE_SIZE = 1000;
/** Two requests a second. */
export const TYPEFORM_MIN_INTERVAL_MS = 500;
/** The scopes a token needs, and should be the only ones it holds. */
export const TYPEFORM_READ_SCOPES = ["forms:read", "responses:read"] as const;
/** What the client may read, and nothing else. */
export const TYPEFORM_READS = ["form", "responses"] as const;
export type TypeformRead = (typeof TYPEFORM_READS)[number];

export const TYPEFORM_FORM_ID = /^[A-Za-z0-9]{1,32}$/;
/** A response token, which `before` takes to page back. */
export const TYPEFORM_TOKEN = /^[A-Za-z0-9]{1,128}$/;

export interface TypeformClientOptions {
  /** A personal access token with forms:read and responses:read only. */
  accessToken: string;
  /** Which of Typeform's hosts the account's responses live on. api.typeform.com when absent. */
  host?: string;
  fetch?: typeof globalThis.fetch;
  /** Waits between requests and before retrying; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch; replaced in tests. */
  clock?: () => number;
  /** Times a 429 is retried here before the error goes to runSync. */
  rateLimitRetries?: number;
}

export class TypeformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeformConfigError";
  }
}

export class TypeformApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "TypeformApiError";
    this.status = status;
    this.code = code;
  }
}

export interface TypeformResponsesQuery {
  /** Unix seconds, inclusive. */
  since: number;
  /** Unix seconds, inclusive. */
  until: number;
  /** The token of the last response on the previous page. */
  before?: string;
}

export interface TypeformClient {
  readonly host: TypeformHost;
  get(read: "form", formId: string): Promise<Record<string, unknown>>;
  get(read: "responses", formId: string, query: TypeformResponsesQuery): Promise<Record<string, unknown>>;
}

const MAX_RETRY_AFTER_S = 60;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isSeconds = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 1e11;

export function typeformHost(value: string | undefined): TypeformHost {
  const host = (value?.trim() || "api.typeform.com").toLowerCase();
  const found = TYPEFORM_HOSTS.find((h) => h === host);
  if (!found) throw new TypeformConfigError(`TYPEFORM_API_HOST must be one of ${TYPEFORM_HOSTS.join(", ")}`);
  return found;
}

/** Typeform's message for an error, cut short. Error bodies describe the request, never the token. */
function messageOf(body: unknown): { code?: string; text: string } {
  const b = (body ?? {}) as { code?: unknown; description?: unknown };
  return {
    ...(typeof b.code === "string" ? { code: b.code.slice(0, 40) } : {}),
    text: typeof b.description === "string" ? b.description.slice(0, 200) : "",
  };
}

export function typeformClient(options: TypeformClientOptions): TypeformClient {
  const token = options.accessToken?.trim() ?? "";
  if (!token) throw new TypeformConfigError("set TYPEFORM_ACCESS_TOKEN");
  if (/\s/.test(token)) throw new TypeformConfigError("TYPEFORM_ACCESS_TOKEN has spaces in it; copy the token again");
  const host = typeformHost(options.host);
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? (() => Date.now());
  const retries = options.rateLimitRetries ?? 3;
  let lastStart = Number.NEGATIVE_INFINITY;

  async function get(read: TypeformRead, formId: string, query?: TypeformResponsesQuery): Promise<Record<string, unknown>> {
    if (!TYPEFORM_READS.includes(read)) throw new TypeformConfigError("the Typeform connector only reads forms and their responses");
    if (typeof formId !== "string" || !TYPEFORM_FORM_ID.test(formId)) throw new TypeformConfigError("a Typeform form id is letters and digits, as in the form's URL");
    const params = new URLSearchParams();
    let path = `/forms/${formId}`;
    if (read === "responses") {
      if (!query || !isSeconds(query.since) || !isSeconds(query.until) || query.since > query.until) {
        throw new TypeformConfigError("responses are read between two times, in Unix seconds");
      }
      if (query.before !== undefined && !TYPEFORM_TOKEN.test(query.before)) throw new TypeformConfigError("before must be a Typeform response token");
      path += "/responses";
      params.set("page_size", String(TYPEFORM_PAGE_SIZE));
      params.set("since", String(query.since));
      params.set("until", String(query.until));
      if (query.before !== undefined) params.set("before", query.before);
    } else if (query !== undefined) {
      throw new TypeformConfigError("a form is read without parameters");
    }
    const qs = params.toString();
    const url = `https://${host}${path}${qs ? `?${qs}` : ""}`;

    for (let attempt = 0; ; ) {
      const wait = lastStart + TYPEFORM_MIN_INTERVAL_MS - clock();
      if (wait > 0) await sleep(wait);
      lastStart = clock();
      // GET only: the connector never creates, changes or deletes anything in Typeform.
      const response = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (response.status === 429) {
        if (attempt < retries) {
          const after = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 1000 * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new TypeformApiError("Typeform kept rate-limiting the sync; the next run resumes from the checkpoint", 429);
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const { code, text } = messageOf(body);
        const hint =
          response.status === 401 || response.status === 403
            ? `; check that TYPEFORM_ACCESS_TOKEN is current and holds ${TYPEFORM_READ_SCOPES.join(" and ")}`
            : response.status === 404
              ? "; check the form id, and that the token's account owns the form"
              : "";
        throw new TypeformApiError(`Typeform answered HTTP ${response.status}${text ? `: ${text}` : ""}${hint}`, response.status, code);
      }
      if (!body || typeof body !== "object") throw new TypeformApiError("Typeform did not answer with JSON", response.status);
      return body as Record<string, unknown>;
    }
  }

  return { host, get: get as TypeformClient["get"] };
}

/**
 * Checks a form's own link to its responses names the host the client
 * uses. Typeform answers an empty list from the wrong region, so a wrong
 * host would look like a form nobody filled in.
 */
export function checkTypeformRegion(form: Record<string, unknown>, host: TypeformHost): void {
  const link = (form._links as { responses?: unknown } | undefined)?.responses;
  if (typeof link !== "string") return;
  let linked: string;
  try {
    linked = new URL(link).hostname.toLowerCase();
  } catch {
    return;
  }
  if (linked === host) return;
  const known = TYPEFORM_HOSTS.find((h) => h === linked);
  throw new TypeformConfigError(
    known ? `this Typeform account keeps its responses on ${known}; set TYPEFORM_API_HOST to ${known}` : "Typeform linked the form's responses to a host the connector doesn't know",
  );
}

interface TypeformField {
  id?: unknown;
  ref?: unknown;
  title?: unknown;
  type?: unknown;
  properties?: { fields?: unknown };
}

/** Question titles by field id, groups included, from a form definition. Titles are the form author's words. */
export function typeformFieldTitles(definition: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const walk = (fields: unknown) => {
    if (!Array.isArray(fields)) return;
    for (const f of fields as TypeformField[]) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.id === "string" && typeof f.title === "string") titles.set(f.id, f.title.slice(0, 200));
      walk(f.properties?.fields);
    }
  };
  walk((definition as { fields?: unknown } | null)?.fields);
  return titles;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * One Typeform answer as the profile sees it. Only choice labels, typed
 * text, dates, numbers and contact details are carried, and only for the
 * profile to pick from; file, link, payment, signature and media answers
 * are counted or ignored, never read. A choice's "other" text is the
 * customer's own words, so it is carried as text, not as a label.
 */
export function typeformAnswer(answer: unknown, titles: ReadonlyMap<string, string>): FormAnswer[] {
  const a = (answer ?? {}) as { type?: unknown; field?: { id?: unknown; ref?: unknown }; [key: string]: unknown };
  const id = str(a.field?.id);
  const names = [id, str(a.field?.ref), id ? titles.get(id) : undefined].filter((n): n is string => !!n);
  const one = (kind: FormAnswer["kind"], values: string[] = [], number?: number): FormAnswer => ({ names, kind, values, ...(number === undefined ? {} : { number }) });
  switch (a.type) {
    case "choice": {
      const c = (a.choice ?? {}) as { label?: unknown; other?: unknown };
      const out: FormAnswer[] = [];
      if (str(c.label)) out.push(one("choice", [c.label as string]));
      if (str(c.other)) out.push(one("text", [c.other as string]));
      return out;
    }
    case "choices": {
      const c = (a.choices ?? {}) as { labels?: unknown; other?: unknown };
      const labels = Array.isArray(c.labels) ? c.labels.filter((l): l is string => !!str(l)) : [];
      const out: FormAnswer[] = labels.length ? [one("choice", labels)] : [];
      if (str(c.other)) out.push(one("text", [c.other as string]));
      return out;
    }
    case "text":
      return str(a.text) ? [one("text", [a.text as string])] : [];
    case "email":
      return str(a.email) ? [one("email", [a.email as string])] : [];
    case "phone_number":
      return str(a.phone_number) ? [one("phone", [a.phone_number as string])] : [];
    case "date":
      return str(a.date) ? [one("date", [a.date as string])] : [];
    case "number":
      return typeof a.number === "number" ? [one("number", [], a.number)] : [];
    case "boolean":
      return [one("boolean")];
    case "file_url":
      // Counted, never followed or kept: the link opens the customer's photo.
      return [one("file")];
    default:
      return [];
  }
}

export interface TypeformResponseItem {
  response_id?: unknown;
  token?: unknown;
  submitted_at?: unknown;
  answers?: unknown;
  [field: string]: unknown;
}

/** A Typeform response, from the Responses API or a webhook's form_response, as a submission. Hidden fields, scores, variables and metadata are never read. */
export function typeformSubmission(formId: string, item: TypeformResponseItem, titles: ReadonlyMap<string, string>, formTitle: string | undefined): FormSubmission {
  const responseId = str(item.response_id) ?? str(item.token) ?? "";
  return {
    provider: "typeform",
    formId,
    responseId,
    submittedAt: str(item.submitted_at),
    ...(formTitle ? { formTitle } : {}),
    answers: Array.isArray(item.answers) ? item.answers.flatMap((a) => typeformAnswer(a, titles)) : [],
  };
}
