/**
 * The smallest SQL surface the store needs. `pg` (Pool or Client) and
 * PGlite both satisfy it, so the store runs against Supabase in production
 * and an embedded Postgres in tests.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
