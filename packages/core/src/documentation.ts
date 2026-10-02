import type { DocumentationState } from "./reasoning.js";
import type { DocumentationSource } from "./layers.js";

/** A source-of-truth document Brain A expects, at a known version. */
export interface RegisteredDocument {
  id: string;
  title: string;
  version: string;
}

/**
 * Layer 7. Compares the registry the code expects with what the document
 * store currently holds. Any missing or changed document is drift, and drift
 * marks every recommendation degraded until the registry is updated.
 */
export class RegistryDocumentationSource implements DocumentationSource {
  constructor(
    private readonly expected: RegisteredDocument[],
    private readonly fetchCurrent: () => Promise<{ id: string; version: string }[]>,
  ) {}

  async current(): Promise<DocumentationState> {
    const documentIds = this.expected.map((d) => d.id);
    let actual: { id: string; version: string }[];
    try {
      actual = await this.fetchCurrent();
    } catch (error) {
      return { documentIds, stale: true, reason: `documentation store unreachable: ${(error as Error).message}` };
    }
    const versions = new Map(actual.map((d) => [d.id, d.version]));
    const drift = this.expected.flatMap((doc) => {
      const found = versions.get(doc.id);
      if (found === undefined) return [`${doc.title} is missing`];
      if (found !== doc.version) return [`${doc.title} is at ${found}, expected ${doc.version}`];
      return [];
    });
    return drift.length ? { documentIds, stale: true, reason: drift.join("; ") } : { documentIds, stale: false };
  }
}
