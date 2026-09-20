/**
 * Measure every lens on this machine's real material.
 *
 *   JEV_API_KEY=... npx tsx apps/bench/run.ts [j1 j2 ...] [--json out.json]
 *
 * Everything reported here is measured. Claude's own usage and cost fields, the
 * Jev API's token counts, and — for J6 — the usage a real transcript recorded at
 * the time. Nothing is scaled from a sample or modelled.
 */
import { writeFile } from "node:fs/promises";
import { j1, j2, j3, j4, j5, j6, j7 } from "./lenses.js";
import type { LensResult } from "./types.js";

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The largest real sessions on this machine: the ones with something to measure. */
async function realTranscripts(count: number): Promise<string[]> {
  const root = join(homedir(), ".claude", "projects");
  const found: { path: string; size: number }[] = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (!file.name.endsWith(".jsonl")) continue;
      const { size } = await import("node:fs/promises").then((fs) => fs.stat(join(dir, file.name)));
      found.push({ path: join(dir, file.name), size });
    }
  }
  return found.sort((a, b) => b.size - a.size).slice(0, count).map((entry) => entry.path);
}

const TRANSCRIPTS = await realTranscripts(8);
const TRANSCRIPT = process.env.JEVUSHER_TRANSCRIPT ?? TRANSCRIPTS[0]!;

const RUNNERS: Record<string, () => Promise<LensResult>> = {
  j1,
  j2,
  j3,
  j4,
  j5: () => j5(TRANSCRIPT),
  j6: () => j6(TRANSCRIPTS),
  j7,
};

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");
const jsonPath = jsonIndex === -1 ? null : args[jsonIndex + 1];
const wanted = args.filter((arg) => arg.startsWith("j") && arg in RUNNERS);
const selected = wanted.length ? wanted : Object.keys(RUNNERS);

const results: LensResult[] = [];

for (const key of selected) {
  process.stdout.write(`\n running ${key} ... `);
  try {
    const result = await RUNNERS[key]!();
    results.push(result);
    process.stdout.write("ok\n");
    report(result);
  } catch (error) {
    process.stdout.write(`FAILED: ${(error as Error).message}\n`);
  }
}

if (jsonPath) {
  await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${jsonPath}`);
}

summary(results);

function report(result: LensResult): void {
  const a = result.without;
  const b = result.with;
  const pct = (from: number, to: number) => (from === 0 ? "—" : `${Math.round((1 - to / from) * 100)}%`);

  console.log(`\n  ${result.lens} · ${result.title}`);
  console.log(`  ${result.source}`);
  console.log(`\n                      ${a.label.padEnd(36).slice(0, 36)}${b.label}`);
  console.log(
    `    material tokens   ${String(a.materialTokens.toLocaleString()).padEnd(36)}${b.materialTokens.toLocaleString()}  (${pct(a.materialTokens, b.materialTokens)} less)`,
  );
  console.log(`    total tokens      ${String(a.totalTokens.toLocaleString()).padEnd(36)}${b.totalTokens.toLocaleString()}`);
  console.log(
    `    cost              ${`$${a.costUsd.toFixed(4)}`.padEnd(36)}$${b.costUsd.toFixed(4)}  (${pct(a.costUsd, b.costUsd)} less)`,
  );
  if (a.ms && b.ms) console.log(`    seconds           ${(a.ms / 1000).toFixed(1).padEnd(36)}${(b.ms / 1000).toFixed(1)}`);
  if (a.model !== b.model) console.log(`    model             ${a.model.padEnd(36)}${b.model}`);
  console.log(`\n    doorman: ${result.doorman.note}`);
  console.log(
    `    doorman cost: $${result.doorman.costUsd.toFixed(5)} (${result.doorman.tokens.toLocaleString()} tokens, ${result.doorman.ms}ms)`,
  );
  if (result.floorTokens) console.log(`    fixed floor, both sides: ${result.floorTokens.toLocaleString()} tokens`);
  if (result.caveat) console.log(`\n    note: ${result.caveat}`);
}

function summary(all: LensResult[]): void {
  if (all.length === 0) return;
  console.log(`\n${"=".repeat(78)}\n  SUMMARY — every figure measured on real material\n${"=".repeat(78)}\n`);
  console.table(
    all.map((result) => ({
      lens: `${result.lens} ${result.title}`,
      "material before": result.without.materialTokens.toLocaleString(),
      "material after": result.with.materialTokens.toLocaleString(),
      "cost before": `$${result.without.costUsd.toFixed(4)}`,
      "cost after": `$${result.with.costUsd.toFixed(4)}`,
      "doorman cost": `$${result.doorman.costUsd.toFixed(5)}`,
    })),
  );

  const savedCost = all.reduce((sum, r) => sum + (r.without.costUsd - r.with.costUsd), 0);
  const doormanCost = all.reduce((sum, r) => sum + r.doorman.costUsd, 0);
  console.log(
    `  cost avoided across all lenses : $${savedCost.toFixed(4)}\n` +
      `  what the doorman cost to run   : $${doormanCost.toFixed(5)}\n` +
      `  net                            : $${(savedCost - doormanCost).toFixed(4)}\n`,
  );
  console.log(
    `  These are single runs on one machine's material, not a benchmark average.\n` +
      `  Re-run them yourself; the numbers move.\n`,
  );
}
