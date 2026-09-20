import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LedgerEntry } from "./ledger.js";
import type { Candidate } from "./types.js";
import type { Capability } from "./gate.js";

export function jevusherHome(): string {
  return process.env.JEVUSHER_HOME ?? join(homedir(), ".claude", "jevusher");
}

export function ledgerPath(): string {
  return process.env.JEVUSHER_LEDGER ?? join(jevusherHome(), "ledger.jsonl");
}

/** Read a JSONL file into records, skipping blank and malformed lines. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A corrupt line must not take the whole store down.
    }
  }
  return out;
}

export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function loadMemory(): Promise<Candidate[]> {
  const path = process.env.JEVUSHER_MEMORY ?? join(jevusherHome(), "memory.jsonl");
  const rows = await readJsonl<Partial<Candidate>>(path);
  return rows
    .filter((row): row is Candidate => typeof row.id === "string" && typeof row.text === "string")
    .map((row) => ({ id: row.id, text: row.text, ...(row.tokens !== undefined && { tokens: row.tokens }) }));
}

export async function loadCatalog(): Promise<Capability[]> {
  const path = process.env.JEVUSHER_CATALOG ?? join(jevusherHome(), "catalog.jsonl");
  const rows = await readJsonl<Partial<Capability>>(path);
  return rows.filter(
    (row): row is Capability =>
      typeof row.id === "string" && typeof row.name === "string" && typeof row.summary === "string",
  );
}

export async function recordEntries(entries: readonly LedgerEntry[], context: Record<string, unknown> = {}): Promise<void> {
  const path = ledgerPath();
  for (const entry of entries) {
    await appendJsonl(path, { ...entry, ...context });
  }
}
