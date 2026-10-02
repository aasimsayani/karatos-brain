/**
 * Layer 2, Entity Normalization. Source records are mapped onto a small set of
 * canonical jewelry-business entities so every later layer speaks one language.
 */
export type EntityKind = "customer" | "product" | "order" | "payment" | "supplier";

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

export interface NormalizedEntity<T extends Record<string, unknown> = Record<string, unknown>> {
  ref: EntityRef;
  organizationId: string;
  attributes: T;
  /** Event ids this entity version was derived from. */
  sourceEventIds: string[];
  updatedAt: string;
}

export type Metal = "gold" | "silver" | "platinum" | "palladium";

export interface ProductAttributes extends Record<string, unknown> {
  sku: string;
  title: string;
  metal?: Metal;
  /** Gold karat (e.g. 14, 18, 22). Only meaningful when metal is gold. */
  karat?: number;
  weightGrams?: number;
  priceCents?: number;
}
