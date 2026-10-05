import type { DocumentationSource, DocumentationState } from "@karatos/core";

/**
 * Documentation layer for a deployed instance. With no registered docs,
 * reasoning is marked degraded rather than pretending to be grounded.
 */
export class StaticDocumentationSource implements DocumentationSource {
  constructor(private readonly documentIds: string[]) {}

  current(): DocumentationState {
    if (this.documentIds.length === 0) {
      return { documentIds: [], stale: true, reason: "no documentation registry configured (DOC_REGISTRY_IDS)" };
    }
    return { documentIds: [...this.documentIds], stale: false };
  }
}
