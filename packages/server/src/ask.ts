import type { StoredEvent } from "@karatos/core";
import {
  answerQuestion,
  ASK_EVENT_TYPES,
  ASK_MAX_EVENTS,
  BRIEF_OPEN_LOOKBACK_DAYS,
  BRIEF_SALE_TYPES,
  openFindingsFor,
  routeQuestion,
  type AskAnswer,
  type AskData,
} from "@karatos/retail";
import type { BriefSources } from "./brief.js";

/**
 * Asking a running instance a question: working out what the question needs,
 * reading only that from the store, and answering it. Read-only: nothing is
 * reasoned, saved or sent. See docs/ask.md.
 */

/** Most events whose system is looked up to cite the findings in one answer. */
export const ASK_MAX_SOURCE_LOOKUPS = 500;

/** Looks up the system each event came from, as many as the cap allows, a batch at a time. */
async function sourcesOf(sources: BriefSources, ids: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const wanted = [...new Set(ids)].slice(0, ASK_MAX_SOURCE_LOOKUPS);
  for (let i = 0; i < wanted.length; i += 50) {
    const found = await Promise.all(wanted.slice(i, i + 50).map((id) => sources.memory.getEvent(sources.organizationId, id)));
    for (const event of found) if (event) out[event.id] = event.source;
  }
  return out;
}

export async function readAnswer(sources: BriefSources, question: string): Promise<AskAnswer> {
  const { memory, organizationId, timeZone } = sources;
  const now = (sources.now ?? (() => new Date()))();
  const route = routeQuestion(question, { now, timeZone });
  const data: AskData = { organizationId, timeZone, generatedAt: now.toISOString() };
  if (route.kind !== "intent") return answerQuestion(question, route, data);

  const { intent, period } = route;
  // Anything up to the end of the day under way counts as synced; an event dated later than that is left out.
  const end = new Date(now.getTime() + 86_400_000).toISOString();
  const types = ASK_EVENT_TYPES[intent];
  const latest = (): Promise<StoredEvent | null> => (types.length ? memory.latestEventBefore(organizationId, types, end) : Promise.resolve(null));

  if (intent === "sales") {
    const [events, lastSaleBefore, latestSynced] = await Promise.all([
      memory.eventsBetween(organizationId, BRIEF_SALE_TYPES, period!.from, period!.to, ASK_MAX_EVENTS + 1),
      memory.latestEventBefore(organizationId, BRIEF_SALE_TYPES, period!.from),
      latest(),
    ]);
    return answerQuestion(question, route, {
      ...data,
      sales: { events: events.slice(0, ASK_MAX_EVENTS), truncated: events.length > ASK_MAX_EVENTS },
      lastSaleBefore,
      latestSynced,
    });
  }

  if (intent === "sync_health") return answerQuestion(question, route, { ...data, ...(sources.sync ? { sync: sources.sync() } : {}) });

  const since = new Date(now.getTime() - BRIEF_OPEN_LOOKBACK_DAYS * 86_400_000).toISOString();
  const recommendations = await memory.recommendationsBetween(organizationId, since, new Date(now.getTime() + 1).toISOString());
  const [feedback, latestSynced] = await Promise.all([memory.listFeedback(organizationId, recommendations.map((r) => r.id)), latest()]);
  // The events of the findings this answer is about, highest impact first, up to the lookup cap.
  const eventSources = await sourcesOf(
    sources,
    openFindingsFor(intent, recommendations, feedback).flatMap(({ finding }) => finding.eventIds),
  );
  // The sync input carries when scheduled reasoning last refreshed the findings.
  return answerQuestion(question, route, { ...data, recommendations, feedback, latestSynced, eventSources, ...(sources.sync ? { sync: sources.sync() } : {}) });
}
