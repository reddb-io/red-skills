import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { extractSql } from "../src/extract-sql.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeSql(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-extract-sql-"));
  roots.push(root);
  const path = join(root, "schema.sql");
  await writeFile(path, source, "utf8");
  return path;
}

describe("extractSql", () => {
  test("extracts tables, columns, and foreign-key references", async () => {
    const path = await writeSql(`
      CREATE TABLE users (
        id uuid primary key,
        email text not null
      );

      CREATE TABLE sessions (
        id uuid primary key,
        user_id uuid references users(id),
        expires_at timestamptz
      );
    `);

    const result = await extractSql(path);

    expect(result.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining([
        `file:${path}`,
        `sym:${path}#table:users`,
        `sym:${path}#table:sessions`,
        `sym:${path}#column:users.email`,
        `sym:${path}#column:sessions.user_id`,
      ]),
    );
    expect(result.nodes.find((node) => node.label.endsWith("#table:users"))?.properties).toMatchObject({
      language: "sql",
      sql_kind: "table",
    });
    expect(result.nodes.find((node) => node.label.endsWith("#column:sessions.user_id"))?.properties).toMatchObject({
      sql_kind: "column",
      sql_table: "sessions",
      sql_type: "uuid",
    });
    expect(result.edges).toEqual(
      expect.arrayContaining([
        {
          fromLabel: `sym:${path}#table:users`,
          toLabel: `file:${path}`,
          label: "DEFINED_IN",
        },
        {
          fromLabel: `sym:${path}#column:sessions.user_id`,
          toLabel: `sym:${path}#table:sessions`,
          label: "DEFINED_IN",
        },
        {
          fromLabel: `sym:${path}#column:sessions.user_id`,
          toLabel: `sym:${path}#table:users`,
          label: "REFERENCES",
        },
      ]),
    );
  });
});
