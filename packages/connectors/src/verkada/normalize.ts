import { createHash } from "node:crypto";

/**
 * Turns Verkada's occupancy trends into Brain A events: one
 * `store.traffic_counted` for each hour across each counting line (a
 * camera's preset), with how many people came in and went out, the
 * camera's name and its site, so sales can be set against footfall hour by
 * hour.
 *
 * Verkada writes each hour as [start, end, count] in Unix seconds, in and
 * out apart, so an hour's two counts are joined by its start. An event is
 * dated at the end of its hour and keyed by the line, the hour and a digest
 * of what was kept, so reading an hour again unchanged is a duplicate and
 * a recount is a new event. The site's street address and the
 * organization's name aren't kept. An hour that doesn't read, or an answer
 * that isn't for the camera asked about, is dead-lettered listing what was
 * wrong.
 */

export interface VerkadaEvent {
  id: string;
  type: string;
  occurredAt: string | undefined;
  receivedAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface VerkadaContext {
  receivedAt: string;
}

export const VERKADA_TRAFFIC_EVENT = "store.traffic_counted";
const SYSTEM = "Verkada";
const HOUR_S = 3600;
const short = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
/** Text Verkada keeps, trimmed, without markup, up to 200 characters. */
const text = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t !== "" && t.length <= 200 && !/[<>\p{Cc}]/u.test(t) ? t : undefined;
};
const iso = (s: number) => new Date(s * 1000).toISOString();

/** One hour as Verkada writes it: [start, end, count], an hour apart, with a count of zero or more. */
function hour(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => Number.isSafeInteger(n))) return null;
  const [start, end, count] = v as number[];
  return start! > 0 && end! - start! === HOUR_S && count! >= 0 ? [start!, count!] : null;
}

function deadLetter(problems: string[], raw: unknown, ctx: VerkadaContext): VerkadaEvent {
  const key = `verkada:unreadable_traffic:${short(raw)}`;
  return { id: key.replace(/:/g, "_"), type: VERKADA_TRAFFIC_EVENT, occurredAt: undefined, receivedAt: ctx.receivedAt, idempotencyKey: key, payload: { system: SYSTEM, problems } };
}

/** The hours of one answer for one camera's preset line, as events, with a dead letter for each hour that doesn't read. */
export function verkadaTrafficEvents(raw: unknown, cameraId: string, presetId: string, ctx: VerkadaContext): VerkadaEvent[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (r.camera_id !== cameraId) problems.push("the answer is not for the camera asked about");
  if (!Array.isArray(r.trend_in) || !Array.isArray(r.trend_out)) problems.push("the answer has no counts in and out");
  if (problems.length > 0) return [deadLetter(problems, raw, ctx)];

  const hours = new Map<number, { entered: number | undefined; exited: number | undefined }>();
  const out: VerkadaEvent[] = [];
  for (const [list, field] of [
    [r.trend_in as unknown[], "entered"],
    [r.trend_out as unknown[], "exited"],
  ] as const) {
    for (const entry of list) {
      const h = hour(entry);
      if (!h) {
        out.push(deadLetter([`an hour of counts ${field === "entered" ? "in" : "out"} doesn't read`], { cameraId, presetId, entry }, ctx));
        continue;
      }
      const slot = hours.get(h[0]) ?? { entered: undefined, exited: undefined };
      slot[field] = h[1];
      hours.set(h[0], slot);
    }
  }
  const camera = text(r.camera_name);
  const site = text(r.camera_site);
  for (const [start, counts] of [...hours].sort((a, b) => a[0] - b[0])) {
    const payload = {
      system: SYSTEM,
      cameraId: `verkada:camera:${cameraId}`,
      presetId,
      camera,
      site,
      hourStart: iso(start),
      hourEnd: iso(start + HOUR_S),
      entered: counts.entered,
      exited: counts.exited,
    };
    const key = `verkada:traffic:${cameraId}:${presetId}:${start}:${short(payload)}`;
    out.push({ id: key.replace(/:/g, "_"), type: VERKADA_TRAFFIC_EVENT, occurredAt: payload.hourEnd, receivedAt: ctx.receivedAt, idempotencyKey: key, payload });
  }
  return out;
}
