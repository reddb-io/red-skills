import { readFile } from "node:fs/promises";
import { contentHash } from "./hash.js";
import type { EdgeLabel, MemoryNode } from "./schema.js";

export interface SqlExtraction {
  nodes: MemoryNode[];
  edges: Array<{ fromLabel: string; toLabel: string; label: EdgeLabel }>;
}

interface TableHit {
  name: string;
  body: string;
  line: number;
}

interface ColumnHit {
  table: string;
  name: string;
  type: string;
  line: number;
}

interface ForeignKeyHit {
  table: string;
  column: string;
  targetTable: string;
  targetColumn?: string;
}

export async function extractSql(path: string): Promise<SqlExtraction> {
  const source = await readFile(path, "utf8");
  const fileNode: MemoryNode = {
    label: `file:${path}`,
    node_type: "file",
    properties: {
      title: path,
      language: "sql",
      source: path,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-sql",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, source),
    },
  };
  const tables = extractTables(source);
  const columns = tables.flatMap((table) => extractColumns(table));
  const foreignKeys = tables.flatMap((table) => extractForeignKeys(table));
  const nodes: MemoryNode[] = [
    fileNode,
    ...tables.map((table) => tableNode(path, table)),
    ...columns.map((column) => columnNode(path, column)),
  ];
  const edges: SqlExtraction["edges"] = [
    ...tables.map((table) => ({
      fromLabel: sqlTableLabel(path, table.name),
      toLabel: fileNode.label,
      label: "DEFINED_IN" as const,
    })),
    ...columns.map((column) => ({
      fromLabel: sqlColumnLabel(path, column.table, column.name),
      toLabel: sqlTableLabel(path, column.table),
      label: "DEFINED_IN" as const,
    })),
  ];
  for (const fk of foreignKeys) {
    edges.push({
      fromLabel: sqlColumnLabel(path, fk.table, fk.column),
      toLabel: sqlTableLabel(path, fk.targetTable),
      label: "REFERENCES",
    });
  }
  return { nodes, edges };
}

function extractTables(source: string): TableHit[] {
  const tables: TableHit[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([`"\[]?[A-Za-z_][\w.]*[`"\]]?)\s*\(([\s\S]*?)\)\s*;/gi;
  for (const match of source.matchAll(re)) {
    const name = normalizeSqlName(match[1] ?? "");
    const body = match[2] ?? "";
    if (!name || !body) continue;
    tables.push({
      name,
      body,
      line: lineForIndex(source, match.index ?? 0),
    });
  }
  return tables;
}

function extractColumns(table: TableHit): ColumnHit[] {
  const columns: ColumnHit[] = [];
  for (const entry of splitSqlList(table.body)) {
    const trimmed = entry.trim();
    if (!trimmed || /^(constraint|primary|foreign|unique|check|exclude)\b/i.test(trimmed)) {
      continue;
    }
    const match = /^([`"\[]?[A-Za-z_]\w*[`"\]]?)\s+([A-Za-z][\w()]*)/i.exec(trimmed);
    if (!match) continue;
    columns.push({
      table: table.name,
      name: normalizeSqlName(match[1] ?? ""),
      type: (match[2] ?? "").toLowerCase(),
      line: table.line,
    });
  }
  return columns;
}

function extractForeignKeys(table: TableHit): ForeignKeyHit[] {
  const keys: ForeignKeyHit[] = [];
  for (const entry of splitSqlList(table.body)) {
    const trimmed = entry.trim();
    const inline = /^([`"\[]?[A-Za-z_]\w*[`"\]]?).*?\breferences\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)(?:\s*\(([`"\[]?[A-Za-z_]\w*[`"\]]?)\))?/i.exec(
      trimmed,
    );
    if (inline) {
      keys.push({
        table: table.name,
        column: normalizeSqlName(inline[1] ?? ""),
        targetTable: normalizeSqlName(inline[2] ?? ""),
        targetColumn: inline[3] ? normalizeSqlName(inline[3]) : undefined,
      });
      continue;
    }
    const tableLevel = /foreign\s+key\s*\(([`"\[]?[A-Za-z_]\w*[`"\]]?)\)\s+references\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)(?:\s*\(([`"\[]?[A-Za-z_]\w*[`"\]]?)\))?/i.exec(
      trimmed,
    );
    if (tableLevel) {
      keys.push({
        table: table.name,
        column: normalizeSqlName(tableLevel[1] ?? ""),
        targetTable: normalizeSqlName(tableLevel[2] ?? ""),
        targetColumn: tableLevel[3] ? normalizeSqlName(tableLevel[3]) : undefined,
      });
    }
  }
  return keys.filter((key) => key.column && key.targetTable);
}

function tableNode(path: string, table: TableHit): MemoryNode {
  return {
    label: sqlTableLabel(path, table.name),
    node_type: "symbol",
    properties: {
      title: table.name,
      summary: "sql table",
      source: `${path}:${table.line}`,
      language: "sql",
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-sql",
        confidence: "EXTRACTED",
        evidence: [`${path}:${table.line}`],
      },
      hash: contentHash(path, "table", table.name),
      sql_kind: "table",
    },
  };
}

function columnNode(path: string, column: ColumnHit): MemoryNode {
  return {
    label: sqlColumnLabel(path, column.table, column.name),
    node_type: "symbol",
    properties: {
      title: `${column.table}.${column.name}`,
      summary: `sql column ${column.type}`,
      source: `${path}:${column.line}`,
      language: "sql",
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-sql",
        confidence: "EXTRACTED",
        evidence: [`${path}:${column.line}`],
      },
      hash: contentHash(path, "column", column.table, column.name, column.type),
      sql_kind: "column",
      sql_table: column.table,
      sql_type: column.type,
    },
  };
}

function splitSqlList(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function sqlTableLabel(path: string, table: string): string {
  return `sym:${path}#table:${table}`;
}

function sqlColumnLabel(path: string, table: string, column: string): string {
  return `sym:${path}#column:${table}.${column}`;
}

function normalizeSqlName(value: string): string {
  return value
    .trim()
    .replace(/^[`"\[]/, "")
    .replace(/[`"\]]$/, "")
    .split(".")
    .pop()
    ?.toLowerCase() ?? "";
}

function lineForIndex(source: string, index: number): number {
  return (source.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}
