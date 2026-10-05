import type { EntityRef } from "./entities.js";

/** Links a record in a source system to a canonical entity. */
export interface IdentityLink {
  organizationId: string;
  source: string;
  externalId: string;
  entity: EntityRef;
}

/**
 * The same source record was linked to two different entities. This is a
 * critical incident: merging silently would corrupt customer history.
 */
export class IdentityCollisionError extends Error {
  constructor(
    readonly link: IdentityLink,
    readonly existing: EntityRef,
  ) {
    super(
      `identity collision: ${link.source}/${link.externalId} is linked to ${existing.kind}/${existing.id}, not ${link.entity.kind}/${link.entity.id}`,
    );
    this.name = "IdentityCollisionError";
  }
}
