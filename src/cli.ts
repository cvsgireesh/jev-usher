import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Jevusher } from "./pipeline.js";
import { Ledger, type LedgerEntry } from "./ledger.js";
import { onPostToolUse, onStop, onUserPromptSubmit, type HookInput } from "./hook.js";
import { jevusherHome, ledgerPath, readJsonl } from "./store.js";

const USAGE = `jevusher — the doorman for your context window

  jevusher install [--global]     wire the hooks into Claude Code settings
  jevusher report                 what the lenses have saved so far
  jevusher doctor                 check key, connectivity, and store files

  jevusher hook <event>           run a hook; reads hook JSON on stdin
                                  events: user-prompt-submit, post-tool-use, stop

  jevusher route                  JSON on stdin -> routing decision
  jevusher admit                  JSON on stdin -> admission decision
  jevusher gate                   JSON on stdin -> capability selection
  jevusher screen                 JSON on stdin -> injection findings
  jevusher stop                   JSON on stdin -> stop decision
  jevusher compact                JSON on stdin -> compaction triage

Environment:
  JEV_API_KEY        required (TYPESAFE_API_KEY also accepted)
  JEVUSHER_HOME      default ~/.claude/jevusher
  JEVUSHER_MEMORY    JSONL of {id,text} recalled memories
  JEVUSHER_CATALOG   JSONL of {id,name,summary,detail?} capabilities
  JEVUSHER_GOAL      the goal the Stop gate checks against
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "install":
      return install(rest.includes("--global"));
    case "report":
      return report();
    case "doctor":
      return doctor();
    case "hook":
      return hook(rest[0]);
    case "route":
    case "admit":
    case "gate":
    case "screen":
    case "stop":
    case "compact":
      return lens(command);
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function readStdinJson<T>(): Promise<T> {
  const raw = (await readStdin()).trim();
  if (!raw) throw new Error("expected JSON on stdin");
  return JSON.parse(raw) as T;
}

/**
 * Hooks must never take the session down with them. Any failure exits 0 with no
 * output, which Claude Code reads as "this hook had nothing to say".
 */
async function hook(event: string | undefined): Promise<number> {
  const handlers = {
    "user-prompt-submit": onUserPromptSubmit,
    "post-tool-use": onPostToolUse,
    stop: onStop,
  } as const;
  const handler = handlers[event as keyof typeof handlers];
  if (!handler) {
    process.stderr.write(`unknown hook event: ${event}\n`);
    return 1;
  }
  try {
    const input = await readStdinJson<HookInput>();
    const output = await handler(input);
    if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    process.stderr.write(`[jevusher] ${(error as Error).message}\n`);
  }
  return 0;
}

async function lens(name: string): Promise<number> {
  // Shapes are validated by the lenses themselves; the CLI just forwards JSON.
  const input = await readStdinJson<never>();
  const jevusher = new Jevusher();
  const runners: Record<string, () => Promise<unknown>> = {
    route: () => jevusher.router.route(input),
    admit: () => jevusher.usher.admit(input),
    gate: () => jevusher.gate.select(input),
    screen: () => jevusher.screen.check(input),
    stop: () => jevusher.stopGate.check(input),
    compact: () => jevusher.compactor.triage(input),
  };
  const result = await runners[name]!();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function report(): Promise<number> {
  const entries = await readJsonl<LedgerEntry>(ledgerPath());
  if (entries.length === 0) {
    process.stdout.write(`No ledger entries yet at ${ledgerPath()}.\nRun some turns with the hooks installed first.\n`);
    return 0;
  }
  const ledger = new Ledger();
  for (const entry of entries) {
    ledger.record(entry.lens, {
      offered: entry.offered,
      admitted: entry.admitted,
      jevUsage: entry.jevUsage,
      requests: entry.requests,
    });
  }
  const summary = ledger.report();

  const rows = Object.entries(summary.byLens).map(([lens, data]) => ({
    lens,
    offered: data.offered,
    admitted: data.admitted,
    kept_out: data.offered - data.admitted,
    jev_tokens: data.jevTokens,
    requests: data.requests,
  }));

  process.stdout.write(`\njevusher ledger — ${summary.entries} entries\n\n`);
  if (rows.length) console.table(rows);
  process.stdout.write(
    `\n  offered to model : ${summary.offered.toLocaleString()} tok` +
      `\n  actually sent    : ${summary.admitted.toLocaleString()} tok` +
      `\n  kept out         : ${summary.saved.toLocaleString()} tok` +
      `\n  jev read         : ${summary.jevTokens.toLocaleString()} tok in ${summary.requests} requests` +
      `\n\n  cost without     : $${summary.cost.targetWithout.toFixed(4)}` +
      `\n  cost with        : $${summary.cost.targetWith.toFixed(4)}` +
      `\n  jev cost         : $${summary.cost.jev.toFixed(4)}` +
      `\n  net              : $${summary.cost.net.toFixed(4)}\n\n` +
      `  Prices are defaults (jev $0.042/Mtok, target $15/Mtok input). These are\n` +
      `  estimates from a rough token count, not your invoice. Check both.\n\n`,
  );
  return 0;
}

async function doctor(): Promise<number> {
  const lines: string[] = [];
  const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  lines.push(`api key     : ${key ? `set (${key.length} chars)` : "MISSING — set JEV_API_KEY"}`);
  lines.push(`home        : ${jevusherHome()}`);

  const memory = await readJsonl(process.env.JEVUSHER_MEMORY ?? join(jevusherHome(), "memory.jsonl"));
  const catalog = await readJsonl(process.env.JEVUSHER_CATALOG ?? join(jevusherHome(), "catalog.jsonl"));
  lines.push(`memory      : ${memory.length} records`);
  lines.push(`catalog     : ${catalog.length} capabilities`);
  lines.push(`ledger      : ${(await readJsonl(ledgerPath())).length} entries`);

  if (key) {
    try {
      const jevusher = new Jevusher();
      const probe = await jevusher.stopGate.check({ goal: "say hello", work: "said hello" });
      lines.push(`connectivity: ok (goal_met ${probe.goalMet?.toFixed(2) ?? "n/a"})`);
    } catch (error) {
      lines.push(`connectivity: FAILED — ${(error as Error).message}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return key ? 0 : 1;
}

const HOOK_COMMAND = "npx --yes jevusher hook";

async function install(global: boolean): Promise<number> {
  const settingsPath = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    // No settings file yet; start from nothing rather than failing.
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const add = (event: string, entry: Record<string, unknown>) => {
    const list = (hooks[event] ??= []);
    const already = JSON.stringify(list).includes("jevusher");
    if (!already) list.push(entry);
  };

  add("UserPromptSubmit", {
    hooks: [{ type: "command", command: `${HOOK_COMMAND} user-prompt-submit`, timeout: 30 }],
  });
  add("PostToolUse", {
    matcher: "WebFetch|WebSearch|mcp__.*",
    hooks: [{ type: "command", command: `${HOOK_COMMAND} post-tool-use`, timeout: 30 }],
  });

  await mkdir(join(settingsPath, ".."), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  process.stdout.write(
    `Wrote hooks to ${settingsPath}\n\n` +
      `  UserPromptSubmit -> route + gate + memory admission\n` +
      `  PostToolUse      -> injection screening on web and MCP output\n\n` +
      `The Stop hook is not installed by default: it can only block stopping, never\n` +
      `stop early, so it fights the agent more often than it helps. Add it yourself\n` +
      `with "${HOOK_COMMAND} stop" if you want goal verification.\n\n` +
      `Next: put memories in ${join(jevusherHome(), "memory.jsonl")} and capabilities in\n` +
      `${join(jevusherHome(), "catalog.jsonl")}, then run "jevusher doctor".\n`,
  );
  return 0;
}
