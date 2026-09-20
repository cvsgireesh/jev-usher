import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { glob } from "node:fs/promises";
import type { Candidate } from "../../src/index.js";
import type { Capability } from "../../src/gate.js";

const run = promisify(execFile);

/** Unlikely to appear inside a sqlite text column, and safe to put in a shell argument. */
const SEP = "~@~";

/**
 * The user's real skill catalog: every SKILL.md installed on this machine.
 * This is the material that actually sits in a system prompt, not a stand-in.
 */
export async function realSkills(limit = 500): Promise<Capability[]> {
  const roots = [join(homedir(), ".claude", "skills"), join(homedir(), ".claude", "plugins", "cache")];
  const paths: string[] = [];
  for (const root of roots) {
    try {
      for await (const entry of glob("**/SKILL.md", { cwd: root })) paths.push(join(root, entry));
    } catch {
      // A root that does not exist on this machine is simply skipped.
    }
  }

  const capabilities: Capability[] = [];
  for (const path of paths.slice(0, limit)) {
    try {
      const raw = await readFile(path, "utf8");
      const name = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim();
      const description = frontmatterDescription(raw);
      if (!name || !description) continue;
      const flat = description.replace(/\s+/g, " ");
      capabilities.push({
        id: name,
        name,
        summary: flat.slice(0, 220), // the one-line form a listing uses
        detail: flat.slice(0, 2000), // the full text a real system prompt carries
      });
    } catch {
      // Unreadable skill files are skipped rather than failing the run.
    }
  }
  return dedupe(capabilities);
}

/** Pull `description` out of YAML frontmatter, handling the folded `>` form. */
function frontmatterDescription(raw: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;
  const block = match[1]!;
  const inline = /^description:\s*(?!>|\|)(.+)$/m.exec(block);
  if (inline) return inline[1]!.trim();
  const folded = /^description:\s*[>|][-+]?\s*\r?\n([\s\S]*?)(?=\r?\n\S|$)/m.exec(block);
  return folded ? folded[1]!.trim() : null;
}

function dedupe(items: Capability[]): Capability[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * The user's real memory store: observations claude-mem actually recorded from
 * past sessions.
 */
export async function realMemories(limit = 60): Promise<Candidate[]> {
  const db = join(homedir(), ".claude-mem", "claude-mem.db");
  const sql =
    "select id, coalesce(nullif(title,''),'') || ' - ' || " +
    "coalesce(nullif(narrative,''), nullif(facts,''), nullif(text,''), '') as body " +
    "from observations where body is not null and length(body) > 40 " +
    `order by created_at_epoch desc limit ${limit};`;
  try {
    const { stdout } = await run("sqlite3", [db, "-separator", SEP, sql], { maxBuffer: 20 * 1024 * 1024 });
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, ...rest] = line.split(SEP);
        return { id: `obs:${id}`, text: rest.join(" ").replace(/\s+/g, " ").slice(0, 900) };
      })
      .filter((candidate) => candidate.text.length > 40);
  } catch {
    return [];
  }
}

/** Real output from a real command, the way a tool result actually arrives. */
export async function realGrep(pattern: string, cwd: string): Promise<Candidate[]> {
  try {
    const { stdout } = await run(
      "grep",
      [
        "-rn",
        "--include=*.ts",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
        "--exclude-dir=.git",
        pattern,
        ".",
      ],
      { cwd, maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line, index) => ({ id: `hit:${index}`, text: line.trim().slice(0, 400) }));
  } catch {
    return [];
  }
}

export interface TranscriptTurn {
  id: string;
  text: string;
  /** Input tokens this turn actually cost, when the transcript recorded it. */
  inputTokens: number;
  role: string;
}

/**
 * A real Claude Code session transcript, flattened into turns.
 *
 * The usage figures are the ones Claude reported at the time, so a turn that is
 * never taken can be priced from what it actually cost, rather than estimated.
 */
export async function realTranscript(path: string, limit = 120): Promise<TranscriptTurn[]> {
  const raw = await readFile(path, "utf8");
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = record.message as { content?: unknown; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined;
    const text = flattenContent(message?.content).replace(/\s+/g, " ").trim();
    if (text.length < 30) continue;
    const usage = message?.usage;
    turns.push({
      id: `turn:${turns.length}`,
      text: text.slice(0, 1500),
      role: String(type),
      inputTokens:
        (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    });
    if (turns.length >= limit) break;
  }
  return turns;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (typeof item.text === "string") parts.push(item.text);
    else if (item.type === "tool_use") parts.push(`[tool: ${String(item.name)}]`);
    else if (item.type === "tool_result") parts.push(flattenContent(item.content).slice(0, 800));
  }
  return parts.join(" ");
}

/**
 * Real source files from this repository.
 *
 * Used as the control set for screening: ordinary content that has no business
 * telling an agent what to do. Skill and tool descriptions are unsuitable for
 * that role, because instructing an agent is precisely their legitimate purpose.
 */
export async function realSourceFiles(count = 12): Promise<Candidate[]> {
  const files: Candidate[] = [];
  try {
    for await (const entry of glob("src/**/*.ts", { cwd: process.cwd() })) {
      if (files.length >= count) break;
      const text = await readFile(join(process.cwd(), entry), "utf8");
      files.push({ id: entry, text: `${entry}\n${text.slice(0, 1800)}` });
    }
  } catch {
    // Nothing to screen is reported by the caller.
  }
  return files;
}
