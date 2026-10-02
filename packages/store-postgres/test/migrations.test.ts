import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { loadMigrations, migrate } from "../src/index.js";
import { freshDatabase, MIGRATIONS_DIR, pgliteClient } from "./helpers.js";

describe("migrations", () => {
  it("apply cleanly and only once", async () => {
    const client = pgliteClient(new PGlite());
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect((await migrate(client, migrations)).length).toBe(migrations.length);
    expect(await migrate(client, migrations)).toEqual([]);
  });

  it("roll back a failing migration", async () => {
    const client = pgliteClient(new PGlite());
    await expect(
      migrate(client, [{ name: "001_bad.sql", sql: "create table half_done (id int); select * from missing_table;" }]),
    ).rejects.toThrow(/001_bad.sql/);
    const { rows } = await client.query("select to_regclass('half_done') as t");
    expect(rows[0]).toEqual({ t: null });
  });

  it("load the seed data", async () => {
    const { client } = await freshDatabase();
    const seed = await readFile(fileURLToPath(new URL("../../../supabase/seed.sql", import.meta.url)), "utf8");
    await client.query(seed);
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from entities where organization_id = 'demo-jewelry'");
    expect(rows[0]?.n).toBe(2);
  });

  it("keep events append-only", async () => {
    const { client } = await freshDatabase();
    await client.query("insert into organizations (id, name) values ('org', 'Org')");
    await client.query(
      `insert into events (id, organization_id, source, type, occurred_at, received_at, idempotency_key)
       values ('e1', 'org', 'manual', 'order.created', now(), now(), 'k1')`,
    );
    await expect(client.query("update events set type = 'order.deleted'")).rejects.toThrow(/append-only/);
    await expect(client.query("delete from events")).rejects.toThrow(/append-only/);
  });

  it("isolate tenants with row-level security", async () => {
    const { client } = await freshDatabase();
    await client.query(`
      insert into organizations (id, name) values ('shop-a', 'A'), ('shop-b', 'B');
      insert into entities (organization_id, kind, id, updated_at) values
        ('shop-a', 'product', 'p1', now()), ('shop-b', 'product', 'p2', now());
      create role app_user;
      grant select, insert on all tables in schema public to app_user;
      set role app_user;
      select set_config('request.jwt.claims', '{"organization_id": "shop-a"}', false);
    `);
    const { rows } = await client.query<{ id: string }>("select id from entities");
    expect(rows.map((r) => r.id)).toEqual(["p1"]);
    await expect(
      client.query("insert into entities (organization_id, kind, id, updated_at) values ('shop-b', 'product', 'x', now())"),
    ).rejects.toThrow(/row-level security/);
  });
});
