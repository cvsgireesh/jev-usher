import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, JevClient, type Provider } from "./client.js";
import { Router, type Tier } from "./route.js";
import { record } from "./validation.js";

const USAGE = 'Usage: jev-usher claude [--no-route] [--model MODEL] "prompt" [-- Claude options]';
const TIERS: Tier[] = [
  { id: "trivial", description: "A simple standalone question, brief reformatting, or a mechanical text conversion. No code changes, repository knowledge, investigation, important judgment, or hidden dependencies are required." },
  { id: "mechanical", description: "A well-specified, limited coding or operational task with clear requirements and a readily verifiable result. No security-sensitive change, unknown root cause, architecture decision, broad refactor, or important ambiguity." },
  { id: "hard", description: "Anything complex, ambiguous, security-sensitive, architectural, open-ended, or dependent on unknown project facts. Includes investigations, broad changes, reviews, difficult debugging, and any request whose correct effort is uncertain." },
];
const MODELS: Record<string, string> = { trivial: "haiku", mechanical: "sonnet", hard: "opus" };
const ROUTING_CONFIDENCE = 0.9;

export interface ModelSelection {
  selectedModel: string;
  tier: string;
  confidence: number | null;
  trusted: boolean;
  requests: number | null;
  inputTokens: number | null;
  /** Estimated JEV input cost; unknown provider prices remain null. */
  costUsd: number | null;
  latencyMs: number;
  reason: string;
  status: "available" | "unavailable";
}

export interface ModelSelectionOptions {
  /** Undefined uses JEV_API_KEY or TYPESAFE_API_KEY; an empty value disables that fallback. */
  apiKey?: string;
  provider?: Provider;
  fallbackModel?: string;
  signal?: AbortSignal;
}

/** One bounded JEV decision shared by the launcher and the comparison UI. */
export async function selectModel(prompt: string, options: ModelSelectionOptions = {}): Promise<ModelSelection> {
  if (!prompt.trim() || prompt.includes("\0")) throw new TypeError("A nonempty launch prompt is required.");
  const fallbackModel = acceptModel(undefined, options.fallbackModel ?? "opus");
  if (options.signal?.aborted) throw new DOMException("Run cancelled.", "AbortError");
  const started = Date.now();
  let requests = 0;
  const fallback = (reason: string): ModelSelection => ({
    selectedModel: fallbackModel, tier: "fallback", confidence: null, trusted: false,
    requests, inputTokens: null, costUsd: null, latencyMs: Date.now() - started, reason, status: "unavailable",
  });
  if (Buffer.byteLength(prompt, "utf8") > 20_000) return fallback("prompt-too-large");
  const apiKey = options.apiKey ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!options.provider && !apiKey) return fallback("missing-api-key");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeRequestAbortListener: (() => void) | undefined;
  try {
    const provider = options.provider ?? new JevClient({
      apiKey, model: DEFAULT_MODEL, timeoutMs: 5_000, maxRetries: 0,
      fetch: (input, init) => {
        const requestSignal = init?.signal;
        const forwardAbort = () => controller.abort();
        if (requestSignal?.aborted) forwardAbort();
        else requestSignal?.addEventListener("abort", forwardAbort, { once: true });
        removeRequestAbortListener = () => requestSignal?.removeEventListener("abort", forwardAbort);
        return globalThis.fetch(input, { ...init, signal: controller.signal });
      },
    });
    let inputTokens: number | null = null;
    let priced = false;
    const router = new Router({ provider: {
      model: DEFAULT_MODEL,
      async evaluate(request) {
        requests++;
        const response = await provider.evaluate(request);
        const tokens = response.usage?.input_tokens;
        inputTokens = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
        priced = response.model === DEFAULT_MODEL;
        return response;
      },
    } });
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Routing interrupted")), { once: true });
      timer = setTimeout(() => controller.abort(), 5_000);
    });
    const result = await Promise.race([
      router.route({ turn: prompt, tiers: TIERS, fallback: "hard", minConfidence: ROUTING_CONFIDENCE, probeWork: false }),
      interrupted,
    ]);
    if (options.signal?.aborted) throw new DOMException("Run cancelled.", "AbortError");
    if (result.model === null) return fallback("provider-unavailable");
    const trusted = result.trusted && result.raw !== null && (result.probabilities?.[result.raw] ?? 0) >= ROUTING_CONFIDENCE && Object.hasOwn(MODELS, result.raw);
    return {
      selectedModel: trusted ? MODELS[result.raw!]! : fallbackModel,
      tier: trusted ? result.raw! : "fallback", confidence: result.confidence, trusted,
      requests, inputTokens, costUsd: inputTokens !== null && priced ? inputTokens * 0.042 / 1e6 : null,
      latencyMs: Date.now() - started, reason: trusted ? "confident-route" : "uncertain-route", status: "available",
    };
  } catch {
    if (options.signal?.aborted) throw new DOMException("Run cancelled.", "AbortError");
    return fallback(controller.signal.aborted ? "routing-timeout" : "provider-unavailable");
  } finally {
    clearTimeout(timer);
    removeRequestAbortListener?.();
    options.signal?.removeEventListener("abort", abort);
  }
}

export interface LaunchDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  packageRoot?: string;
  /** A typed provider seam for offline verification. */
  provider?: Provider;
  stderr?: (message: string) => void;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Defaults to process; an isolated emitter permits shutdown tests without OS signals. */
  signalSource?: Pick<EventEmitter, "on" | "removeListener">;
}

/** Route only a new launch; Claude retains ownership of auth, settings and permissions. */
export async function launchClaude(argv: string[], dependencies: LaunchDependencies = {}): Promise<number> {
  const parsed = parseArguments(argv);
  const env = { ...(dependencies.env ?? process.env) };
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const packageRoot = resolve(dependencies.packageRoot ?? fileURLToPath(new URL("../", import.meta.url)));
  const write = dependencies.stderr ?? ((message: string) => { process.stderr.write(message); });
  const args = [...parsed.claudeArgs];

  await access(join(packageRoot, "dist", "hook.js")).catch(() => {
    throw new Error("Build jev-usher before launching Claude: npm run build.");
  });
  const existing = await alreadyConfigured(args, cwd, env, packageRoot);
  if (!existing) args.push("--plugin-dir", packageRoot);
  else if (existing !== "local-plugin") write("[jev-usher] Using your existing jev-usher installation. Update it after upgrades to use the current hooks.\n");

  const continuing = args.some(arg => ["--resume", "-r", "--continue", "-c", "--fork-session"].includes(arg) || arg.startsWith("--resume="));
  let model = parsed.explicitModel;
  if (model) {
    write(`[jev-usher] Using your explicit model: ${model}.\n`);
  } else if (parsed.noRoute || continuing || env.ANTHROPIC_MODEL) {
    write(`[jev-usher] Keeping Claude's model selection${continuing ? " for this resumed conversation" : ""}.\n`);
  } else {
    if ((dependencies.provider || env.JEV_API_KEY || env.TYPESAFE_API_KEY) && Buffer.byteLength(parsed.prompt, "utf8") <= 20_000) {
      write("[jev-usher] Sending the launch prompt to TypeSafe JEV for model selection.\n");
    }
    const result = await selectModel(parsed.prompt, { apiKey: env.JEV_API_KEY ?? env.TYPESAFE_API_KEY ?? "", provider: dependencies.provider });
    model = result.trusted ? result.selectedModel : undefined;
    write(result.trusted
      ? `[jev-usher] Launch model: ${model} (JEV confidence ${result.confidence!.toFixed(2)}). This choice applies to this launch only.\n`
      : "[jev-usher] Routing was uncertain or unavailable; keeping Claude's configured model.\n");
  }
  if (model && !parsed.modelAlreadyForwarded) args.push("--model", model);
  env.JEVUSHER_FILTER ??= "1";
  args.push("--", parsed.prompt);
  return new Promise(resolveExit => {
    let child: ChildProcess;
    try {
      child = (dependencies.spawn ?? spawn)("claude", args, { cwd, env, stdio: "inherit", shell: false });
    } catch {
      write("[jev-usher] Could not start Claude. Ensure the official claude executable is on PATH.\n");
      resolveExit(127);
      return;
    }
    const signals = dependencies.signalSource ?? process;
    let finished = false;
    let stopping = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(forceStop);
      signals.removeListener("SIGTERM", terminate);
      signals.removeListener("SIGHUP", hangup);
    };
    const forward = (signal: NodeJS.Signals) => {
      if (finished || stopping || child.exitCode != null || child.signalCode != null) return;
      stopping = true;
      // Keep the wrapper alive until its direct child exits. A parent-only signal
      // otherwise leaves Claude running. Ctrl+C still follows terminal group delivery.
      forceStop = setTimeout(() => {
        if (!finished && child.exitCode == null && child.signalCode == null) {
          try { child.kill("SIGKILL"); } catch { /* The child may have exited concurrently. */ }
        }
      }, 5_000);
      try { child.kill(signal); } catch { /* The bounded forced shutdown remains scheduled. */ }
    };
    const terminate = () => forward("SIGTERM");
    const hangup = () => forward("SIGHUP");
    signals.on("SIGTERM", terminate);
    signals.on("SIGHUP", hangup);
    child.once("error", () => {
      if (finished) return;
      finished = true;
      cleanup();
      write("[jev-usher] Could not start Claude. Ensure the official claude executable is on PATH.\n");
      resolveExit(127);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}

function parseArguments(argv: string[]) {
  const separator = argv.indexOf("--");
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const claudeArgs = separator < 0 ? [] : argv.slice(separator + 1);
  if (claudeArgs.includes("--")) throw new TypeError(`${USAGE}\nPass only Claude options after the separator.`);
  let noRoute = false;
  let explicitModel: string | undefined;
  let prompt: string | undefined;
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (arg === "--no-route") noRoute = true;
    else if (arg === "--model" || arg.startsWith("--model=")) {
      const value = arg === "--model" ? own[++i] : arg.slice(8);
      explicitModel = acceptModel(explicitModel, value);
    } else if (arg.startsWith("-") || prompt !== undefined) throw new TypeError(USAGE);
    else prompt = arg;
  }
  if (!prompt?.trim() || prompt.includes("\0")) throw new TypeError(USAGE);
  let modelAlreadyForwarded = false;
  for (let i = 0; i < claudeArgs.length; i++) {
    const arg = claudeArgs[i]!;
    if (arg.includes("\0")) throw new TypeError("Claude arguments must not contain NUL bytes.");
    if (arg === "--model" || arg.startsWith("--model=")) {
      explicitModel = acceptModel(explicitModel, arg === "--model" ? claudeArgs[++i] : arg.slice(8));
      modelAlreadyForwarded = true;
    }
  }
  return { prompt, noRoute, explicitModel, modelAlreadyForwarded, claudeArgs };
}

function acceptModel(previous: string | undefined, value: string | undefined): string {
  if (!value?.trim() || value.startsWith("-") || /[\s\0]/.test(value)) throw new TypeError("--model requires one model alias or ID.");
  if (previous && previous !== value) throw new TypeError("Conflicting --model choices. Supply one explicit model.");
  return value;
}

/** Read only documented settings locations and explicit overlays; never inspect credentials. */
async function alreadyConfigured(args: string[], cwd: string, env: NodeJS.ProcessEnv, packageRoot: string): Promise<false | "local-plugin" | "installed-plugin" | "settings"> {
  const canonical = async (path: string) => realpath(isAbsolute(path) ? path : resolve(cwd, path)).catch(() => resolve(cwd, path));
  const root = await canonical(packageRoot);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plugin-dir" && args[i + 1] && await canonical(args[i + 1]!) === root) return "local-plugin";
    if (args[i]?.startsWith("--plugin-dir=") && await canonical(args[i]!.slice(13)) === root) return "local-plugin";
  }
  let sources = new Set(["user", "project", "local"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--setting-sources" && args[i + 1] !== undefined) sources = new Set(args[++i]!.split(","));
    else if (args[i]?.startsWith("--setting-sources=")) sources = new Set(args[i]!.slice(18).split(","));
  }
  if (args.includes("--restricted")) sources.clear();
  const paths = new Set<string>();
  if (sources.has("user")) paths.add(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"), "settings.json"));
  // Claude can load project settings when launched from a subdirectory.
  let current = cwd;
  while (true) {
    if (sources.has("project")) paths.add(join(current, ".claude", "settings.json"));
    if (sources.has("local")) paths.add(join(current, ".claude", "settings.local.json"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const settings: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = arg === "--settings" ? args[++i] : arg.startsWith("--settings=") ? arg.slice(11) : undefined;
    if (value === undefined) continue;
    if (value.trim().startsWith("{")) { try { settings.push(JSON.parse(value)); } catch { /* Claude reports its own invalid settings. */ } }
    else paths.add(resolve(cwd, value));
  }
  await Promise.all([...paths].map(async path => {
    try { if ((await stat(path)).size <= 2_000_000) settings.push(JSON.parse(await readFile(path, "utf8"))); }
    catch { /* Missing or invalid settings remain Claude's responsibility. */ }
  }));
  const events = new Set<string>();
  for (const value of settings) {
    if (!record(value)) continue;
    if (record(value.enabledPlugins) && Object.entries(value.enabledPlugins).some(([name, enabled]) => /^jev-?usher(?:@|$)/.test(name) && enabled === true)) return "installed-plugin";
    if (!record(value.hooks)) continue;
    for (const [event, argument, requiredTools] of [
      ["UserPromptSubmit", "user-prompt-submit", []],
      ["PreToolUse", "pre-tool-use", ["Edit", "Write"]],
      ["PostToolUse", "post-tool-use", ["Read", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__fixture__read"]],
    ] as const) {
      const groups = value.hooks[event];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!record(group) || !Array.isArray(group.hooks)) continue;
        if (group.hooks.some(handler => record(handler) && handler.type === "command" && typeof handler.command === "string" &&
          new RegExp(`\\bjev-?usher(?:\\.mjs)?['\"]? hook ${argument}$`).test(handler.command))) {
          let coversTools = group.matcher === undefined || group.matcher === "";
          if (typeof group.matcher === "string") {
            try { const matcher = new RegExp(group.matcher); coversTools = requiredTools.every(tool => matcher.test(tool)); }
            catch { /* Invalid matchers are not a compatible installation. */ }
          }
          if (coversTools) events.add(event);
          else events.add("incomplete-matcher");
        }
      }
    }
  }
  if (events.size && (events.size !== 3 || events.has("incomplete-matcher"))) {
    throw new Error("Older or partial jev-usher settings hooks found. Re-run jev-usher install, or uninstall those hooks before using the launcher, to avoid duplicate hooks.");
  }
  return events.size === 3 ? "settings" : false;
}
