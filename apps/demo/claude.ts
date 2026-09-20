import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeRun {
  answer: string;
  /** Everything the model had to read: the prompt plus its fixed tooling floor. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
  model: string;
}

let isolatedSettings: string | null = null;

/** A settings file with nothing in it, so the demo never picks up local hooks or plugins. */
async function settingsPath(): Promise<string> {
  if (isolatedSettings) return isolatedSettings;
  const dir = await mkdtemp(join(tmpdir(), "jevusher-demo-"));
  const path = join(dir, "settings.json");
  await writeFile(path, "{}", "utf8");
  isolatedSettings = path;
  return path;
}

const SYSTEM = "You are a helpful assistant. Answer the user's question using only the material provided. Be concise: three sentences at most.";

/**
 * One real Claude turn on the local subscription.
 *
 * Tools are disallowed and MCP is off so the only thing that varies between the
 * two sides of the demo is the material in the prompt.
 */
export function runClaude(prompt: string, model: string): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    settingsPath().then((settings) => {
      // The prompt goes in on stdin, not argv: a realistically sized context
      // blows past the operating system's argument limit and fails with E2BIG.
      const args = [
        "-p",
        "--output-format", "json",
        "--model", model,
        "--system-prompt", SYSTEM,
        "--exclude-dynamic-system-prompt-sections",
        "--settings", settings,
        "--strict-mcp-config",
        "--disallowed-tools",
        "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit,SlashCommand,Skill",
      ];

      const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write(prompt);
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
        try {
          const parsed = JSON.parse(stdout) as {
            result: string;
            total_cost_usd: number;
            duration_ms: number;
            usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
          };
          const usage = parsed.usage;
          resolve({
            answer: parsed.result,
            inputTokens:
              usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            outputTokens: usage.output_tokens,
            costUsd: parsed.total_cost_usd,
            ms: parsed.duration_ms,
            model,
          });
        } catch (error) {
          reject(new Error(`could not parse claude output: ${(error as Error).message}`));
        }
      });
    }, reject);
  });
}

let floorCache: number | null = null;

/**
 * The tokens every call pays before any material is added: the CLI's own system
 * prompt and tooling. Identical on both sides of the comparison, so it is shown
 * separately rather than booked as a saving.
 */
export async function measureFloor(model: string): Promise<number> {
  if (floorCache !== null) return floorCache;
  const probe = await runClaude("Question: What is 2+2?", model);
  floorCache = probe.inputTokens;
  return floorCache;
}
