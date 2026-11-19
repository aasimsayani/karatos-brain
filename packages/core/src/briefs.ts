/** A daily brief as it was saved: the day it covers, when it was built, and the brief itself. */
export interface SavedBrief {
  organizationId: string;
  /** The store day, YYYY-MM-DD. */
  date: string;
  generatedAt: string;
  brief: Record<string, unknown>;
}

/**
 * Where daily briefs are kept. One brief per organization and day: saving a
 * second one for the same day leaves the first and reports false, so two
 * schedulers (or one restarted) never both send a day's brief.
 */
export interface BriefStore {
  /** Saves the day's brief unless one is already saved. True when this call saved it. */
  saveBrief(brief: SavedBrief): Promise<boolean>;
  getBrief(organizationId: string, date: string): Promise<SavedBrief | null>;
}
