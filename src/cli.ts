import { fileURLToPath } from "node:url";
import { configureHooks, shellQuote } from "./install.js";
import { JevClient } from "./client.js";
import { record } from "./validation.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Jevusher } from "./pipeline.js";
import { Ledger, type LedgerEntry } from "./ledger.js";
import { onPostToolUse, onStop, onUserPromptSubmit, type HookInput } from "./hook.js";
import { jevusherHome, ledgerPath, readJsonl } from "./store.js";

const USAGE = `jevusher — the doorman for your context window

  jevusher install [--global]     wire the hooks into Claude Code settings
  jevusher uninstall [--global]   remove Jevusher hooks, keeping other settings
  jevusher report                 estimated context volume and provider usage
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
    case "uninstall":
      return install(rest.includes("--global"), true);
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
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 2_000_000) throw new Error("stdin exceeds the 2 MB limit");
    chunks.push(data);
  }
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
    if (!record(input)) throw new TypeError("hook input must be an object");
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
  const stored = await readJsonl<LedgerEntry>(ledgerPath());
  const entries = stored.filter(e => record(e) && typeof e.lens === "string" &&
    [e.offered, e.admitted, e.requests].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    record(e.jevUsage) && typeof e.jevUsage.input_tokens === "number" && e.jevUsage.input_tokens >= 0);
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
    estimated_delta: data.offered - data.admitted,
    jev_tokens: data.jevTokens,
    requests: data.requests,
  }));

  process.stdout.write(`\njevusher ledger — ${summary.entries} entries\n\n`);
  if (rows.length) console.table(rows);
  process.stdout.write(
    `\n  offered to model : ${summary.offered.toLocaleString()} tok` +
      `\n  selected/injected: ${summary.admitted.toLocaleString()} tok` +
      `\n  estimated delta  : ${summary.saved.toLocaleString()} tok` +
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
  let healthy = true;
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
      const client = new JevClient({ timeoutMs: 5000, maxRetries: 0 });
      const probe = await client.evaluate({ model: client.model, state: "hello", questions: {
        greeting: { type: "noul", instructions: "Is this a greeting?" },
      } });
      lines.push(`connectivity: ok (${probe.model})`);
    } catch (error) {
      healthy = false;
      lines.push(`connectivity: FAILED — ${(error as Error).message}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return key && healthy ? 0 : 1;
}

async function install(global: boolean, remove = false): Promise<number> {
  const settingsPath = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");
  if (process.platform === "win32") throw new Error("Settings installation currently supports macOS and Linux; use the plugin on other platforms.");
  const executable = fileURLToPath(new URL("../bin/jevusher.mjs", import.meta.url));
  const command = `${shellQuote(process.execPath)} ${shellQuote(executable)}`;
  await configureHooks(settingsPath, command, remove);
  process.stdout.write(`${remove ? "Removed Jevusher hooks from" : "Installed local Jevusher hooks in"} ${settingsPath}\n`);
  if (!remove) process.stdout.write(
    "Keep this installation at its current path. Existing settings were backed up.\n" +
    "Configure memory.jsonl and catalog.jsonl under JEVUSHER_HOME. These records and\n" +
    "your prompt are sent to TypeSafe. Tool screening requires JEVUSHER_SCREEN=1;\n" +
    "MCP tools additionally require an exact-name JEVUSHER_MCP_TOOLS allowlist.\n" +
    "Run jevusher doctor. Routing and skill hints are advisory. Stop is not installed.\n");
  return 0;
}
