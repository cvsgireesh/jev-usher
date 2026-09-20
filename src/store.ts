import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { record } from "./validation.js";
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
    if ((await stat(path)).size > 8_000_000) throw new Error("JSONL store exceeds 8 MB; rotate or reduce it");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadMemory(): Promise<Candidate[]> {
  const path = process.env.JEVUSHER_MEMORY ?? join(jevusherHome(), "memory.jsonl");
  const rows = await readJsonl<Partial<Candidate>>(path);
  return rows
    .filter((row): row is Candidate => record(row) && typeof row.id === "string" && typeof row.text === "string" &&
      (row.tokens === undefined || typeof row.tokens === "number" && Number.isFinite(row.tokens) && row.tokens >= 0))
    .map((row) => ({ id: row.id, text: row.text, ...(row.tokens !== undefined && { tokens: row.tokens }) }));
}

export async function loadCatalog(): Promise<Capability[]> {
  const path = process.env.JEVUSHER_CATALOG ?? join(jevusherHome(), "catalog.jsonl");
  const rows = await readJsonl<Partial<Capability>>(path);
  return rows.filter(
    (row): row is Capability =>
      record(row) && typeof row.id === "string" && typeof row.name === "string" && typeof row.summary === "string",
  );
}

export async function recordEntries(entries: readonly LedgerEntry[], context: Record<string, unknown> = {}): Promise<void> {
  const path = ledgerPath();
  for (const entry of entries) {
    await appendJsonl(path, { ...entry, ...context });
  }
}
