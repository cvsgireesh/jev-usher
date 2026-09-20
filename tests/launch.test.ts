import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, type Provider } from "../src/client.js";
import { launchClaude, selectModel, type LaunchDependencies } from "../src/launch.js";
import type { SystemOneRequest, SystemOneResponse } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function decision(tier = "trivial", confidence = 0.99, probability = 0.99) {
  const requests: SystemOneRequest[] = [];
  const provider: Provider = {
    model: DEFAULT_MODEL,
    async evaluate(request) {
      requests.push(request);
      return {
        model: DEFAULT_MODEL,
        answers: { tier: { type: "choice", choice: tier, confidence, probabilities: { [tier]: probability } } },
        usage: { input_tokens: 123, output_tokens: 0 },
      };
    },
  };
  return { provider, requests };
}

async function fixture(provider?: Provider) {
  const root = await mkdtemp(join(tmpdir(), "jevusher-launch-"));
  temporary.push(root);
  const cwd = join(root, "project");
  const packageRoot = join(root, "package");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd), mkdir(join(packageRoot, "dist"), { recursive: true }), mkdir(home)]);
  await writeFile(join(packageRoot, "dist", "hook.js"), "");
  const output: string[] = [];
  const signals = new EventEmitter();
  const spawned: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const dependencies: LaunchDependencies = {
    cwd, packageRoot, env: { HOME: home, PATH: "/fixture/path" }, provider, signalSource: signals,
    stderr: message => output.push(message),
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child as ChildProcess;
    },
  };
  const settings = async (value: unknown, local = false) => {
    const path = local ? join(cwd, ".claude", "settings.local.json") : join(home, ".claude", "settings.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  return { root, cwd, home, packageRoot, dependencies, output, spawned, settings, signals };
}

function hooks() {
  return { hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "jevusher hook user-prompt-submit" }] }],
    PreToolUse: [{ matcher: "^(Edit|Write)$", hooks: [{ type: "command", command: "jevusher hook pre-tool-use" }] }],
    PostToolUse: [{ matcher: "^(Read|Bash|Grep|Glob|WebFetch|WebSearch|mcp__.*)$", hooks: [{ type: "command", command: "jevusher hook post-tool-use" }] }],
  } };
}

describe("selectModel", () => {
  it.each([["trivial", "haiku"], ["mechanical", "sonnet"], ["hard", "opus"]])("maps confident %s decisions to the actual %s alias", async (tier, model) => {
    const { provider, requests } = decision(tier);
    const result = await selectModel("Synthetic task", { provider });
    expect(result).toMatchObject({ selectedModel: model, tier, trusted: true, confidence: 0.99, requests: 1, inputTokens: 123, status: "available", reason: "confident-route" });
    expect(result.costUsd).toBeCloseTo(123 * 0.042 / 1e6, 12);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(DEFAULT_MODEL);
    expect(requests[0]?.state).toEqual({ turn: "Synthetic task" });
    expect(Object.keys(requests[0]!.questions)).toEqual(["tier"]);
  });

  it.each([[0.85, 0.99], [0.99, 0.85], [0.2, 0.2]])("preserves the configured fallback for confidence %s and probability %s", async (confidence, probability) => {
    const result = await selectModel("Ambiguous task", { provider: decision("trivial", confidence, probability).provider, fallbackModel: "sonnet" });
    expect(result).toMatchObject({ selectedModel: "sonnet", tier: "fallback", trusted: false, status: "available", reason: "uncertain-route" });
    expect(result.inputTokens).toBe(123);
  });

  it("rejects unknown model tiers even when a provider is confident", async () => {
    const result = await selectModel("Task", { provider: decision("__proto__").provider });
    expect(result).toMatchObject({ selectedModel: "opus", trusted: false, reason: "uncertain-route" });
  });

  it("does not describe a failed provider as zero-cost success", async () => {
    const provider: Provider = { model: DEFAULT_MODEL, evaluate: vi.fn().mockRejectedValue(new Error("private provider body")) };
    const result = await selectModel("Task", { provider });
    expect(result).toMatchObject({ selectedModel: "opus", trusted: false, requests: 1, inputTokens: null, costUsd: null, status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("private provider body");
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
  });

  it("does not infer missing usage or unknown provider prices", async () => {
    const provider: Provider = { model: "custom", async evaluate() {
      return { model: "custom", answers: { tier: { type: "choice", choice: "hard", confidence: 0.99, probabilities: { hard: 0.99 } } } } as unknown as SystemOneResponse;
    } };
    expect(await selectModel("Task", { provider })).toMatchObject({ selectedModel: "opus", trusted: true, inputTokens: null, costUsd: null });
  });

  it("treats explicit empty keys and oversized prompts as no-call fallbacks", async () => {
    vi.stubEnv("JEV_API_KEY", "ambient-key-must-not-be-used");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await selectModel("Task", { apiKey: "" })).toMatchObject({ reason: "missing-api-key", requests: 0, selectedModel: "opus" });
    expect(await selectModel("é".repeat(10_001), { apiKey: "test" })).toMatchObject({ reason: "prompt-too-large", requests: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the pinned HTTP model and never retries an unavailable service", async () => {
    const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("JEV_API_KEY", "synthetic-env-key");
    const result = await selectModel("Task");
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(request.body as string).model).toBe(DEFAULT_MODEL);
    expect(request.headers).toMatchObject({ Authorization: "Bearer synthetic-env-key" });
    expect(result.status).toBe("unavailable");
  });

  it("bounds even an injected unresponsive provider to five seconds", async () => {
    vi.useFakeTimers();
    const provider: Provider = { model: DEFAULT_MODEL, evaluate: () => new Promise(() => {}) };
    const pending = selectModel("Task", { provider });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ reason: "routing-timeout", selectedModel: "opus", inputTokens: null, requests: 1 });
  });

  it("cancels before dispatch and aborts an in-flight HTTP request", async () => {
    const first = new AbortController(); first.abort();
    const provider = decision().provider;
    await expect(selectModel("Task", { provider, signal: first.signal })).rejects.toMatchObject({ name: "AbortError" });
    const second = new AbortController();
    let transportSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: unknown, init: RequestInit) => {
      transportSignal = init.signal!;
      return new Promise((_, reject) => transportSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }));
    const pending = selectModel("Task", { apiKey: "synthetic", signal: second.signal });
    second.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
  });

  it.each(["success", "cancel", "timeout"] as const)("supports early Node 20 without AbortSignal.any: %s", async outcome => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      let transportSignal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn((_input: unknown, init: RequestInit) => {
        transportSignal = init.signal!;
        if (outcome === "success") return Promise.resolve(Response.json({
          model: DEFAULT_MODEL,
          answers: { tier: { type: "choice", choice: "trivial", confidence: 0.99, probabilities: { trivial: 0.99, mechanical: 0.005, hard: 0.005 } } },
          usage: { input_tokens: 123, output_tokens: 0 },
        }));
        return new Promise((_, reject) => transportSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }));
      const pending = selectModel("Task", { apiKey: "synthetic", signal: caller.signal });
      if (outcome === "cancel") {
        const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        caller.abort(); await cancelled;
        expect(transportSignal?.aborted).toBe(true);
      } else if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await pending).toMatchObject({ selectedModel: "opus", reason: "routing-timeout", status: "unavailable" });
        expect(transportSignal?.aborted).toBe(true);
      } else {
        expect(await pending).toMatchObject({ selectedModel: "haiku", trusted: true, status: "available", requests: 1 });
        caller.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(transportSignal?.aborted).toBe(false);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor);
      else Reflect.deleteProperty(AbortSignal, "any");
    }
  });

  it.each(["", " ", "bad\0prompt"])("rejects invalid prompt %j before provider use", async prompt => {
    const { provider, requests } = decision();
    await expect(selectModel(prompt, { provider })).rejects.toThrow(/prompt/);
    expect(requests).toHaveLength(0);
  });
});

describe("launchClaude", () => {
  it("routes a new launch, enables local hooks, and passes shell metacharacters literally", async () => {
    const { provider, requests } = decision();
    const f = await fixture(provider);
    const prompt = 'Explain `printf` and $(whoami), without running them';
    expect(await launchClaude([prompt, "--", "--effort", "high", "--permission-mode", "default"], f.dependencies)).toBe(0);
    expect(requests).toHaveLength(1);
    expect(f.spawned[0]).toMatchObject({ command: "claude", args: ["--effort", "high", "--permission-mode", "default", "--plugin-dir", f.packageRoot, "--model", "haiku", "--", prompt], options: { shell: false, stdio: "inherit", cwd: f.cwd, env: { JEVUSHER_FILTER: "1", PATH: "/fixture/path" } } });
    expect(f.dependencies.env?.JEVUSHER_FILTER).toBeUndefined();
    expect(f.output.join("")).not.toContain(prompt);
  });

  it.each([
    ["--model", "sonnet", "Task"],
    ["Task", "--model=sonnet"],
    ["Task", "--", "--model", "sonnet"],
    ["--model=sonnet", "Task", "--", "--model=sonnet"],
  ])("preserves explicit model arguments %j without calling JEV", async (...argv) => {
    const { provider, requests } = decision(); const f = await fixture(provider);
    await launchClaude(argv, f.dependencies);
    expect(requests).toHaveLength(0);
    const args = f.spawned[0]!.args;
    expect(args.filter(arg => arg === "--model" || arg.startsWith("--model="))).toHaveLength(1);
    expect(args).toContain(args.includes("--model") ? "sonnet" : "--model=sonnet");
  });

  it.each(["--resume", "--resume=session", "--continue", "-r", "-c", "--fork-session"])("does not reroute continued conversations (%s)", async flag => {
    const { provider, requests } = decision(); const f = await fixture(provider);
    await launchClaude(["Continue", "--", flag], f.dependencies);
    expect(requests).toHaveLength(0);
    expect(f.spawned[0]!.args).not.toContain("--model");
    expect(f.spawned[0]!.args).toContain(flag);
  });

  it("keeps explicit environment model, credentials, config, and filtering opt-out intact", async () => {
    const { provider, requests } = decision(); const f = await fixture(provider);
    Object.assign(f.dependencies.env!, { ANTHROPIC_MODEL: "custom-model", ANTHROPIC_API_KEY: "user-owned-key", CLAUDE_CODE_OAUTH_TOKEN: "user-owned-token", JEVUSHER_FILTER: "0" });
    await launchClaude(["Task"], f.dependencies);
    expect(requests).toHaveLength(0);
    expect(f.spawned[0]!.args).not.toContain("--model");
    expect(f.spawned[0]!.options.env).toEqual(f.dependencies.env);
    expect(f.output.join("")).not.toMatch(/user-owned/);
  });

  it("preserves Claude defaults under --no-route", async () => {
    const f = await fixture();
    await launchClaude(["--no-route", "Task"], f.dependencies);
    expect(f.spawned[0]!.args).not.toContain("--model");
  });

  it.each(["missing-key", "low-confidence", "low-probability", "unknown-tier", "provider-error", "oversized-prompt"])("leaves Claude's configured model intact when routing cannot be trusted: %s", async reason => {
    const provider = reason === "missing-key" ? undefined
      : reason === "provider-error" ? { model: DEFAULT_MODEL, evaluate: vi.fn().mockRejectedValue(new Error("synthetic provider failure")) }
      : decision(reason === "unknown-tier" ? "unknown" : "trivial", reason === "low-confidence" ? 0.85 : 0.99, reason === "low-probability" ? 0.85 : 0.99).provider;
    const f = await fixture(provider);
    const settingsPath = await f.settings({ model: "sonnet", effortLevel: "high" });
    const before = await readFile(settingsPath, "utf8");
    const prompt = reason === "oversized-prompt" ? "x".repeat(20_001) : "Task";
    expect(await launchClaude([prompt], f.dependencies)).toBe(0);
    expect(f.spawned[0]!.args.some(arg => arg === "--model" || arg.startsWith("--model="))).toBe(false);
    expect(f.spawned[0]!.args).not.toContain("--settings");
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(f.output.join("")).toContain("keeping Claude's configured model");
  });

  it("still applies a confident route over a saved model without changing the settings file", async () => {
    const f = await fixture(decision("trivial").provider);
    const settingsPath = await f.settings({ model: "opus" });
    await launchClaude(["Task"], f.dependencies);
    expect(f.spawned[0]!.args).toContain("--model");
    expect(f.spawned[0]!.args).toContain("haiku");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ model: "opus" });
  });

  it("does not duplicate a supplied plugin directory, including a symlink alias", async () => {
    const f = await fixture();
    const alias = join(f.root, "alias"); await symlink(f.packageRoot, alias);
    await launchClaude(["Task", "--", `--plugin-dir=${alias}`], f.dependencies);
    expect(f.spawned[0]!.args.filter(arg => arg.startsWith("--plugin-dir"))).toEqual([`--plugin-dir=${alias}`]);
  });

  it("uses a complete existing hook installation without writing its settings", async () => {
    const f = await fixture(); const path = await f.settings(hooks()); const before = await readFile(path, "utf8");
    await launchClaude(["Task"], f.dependencies);
    expect(f.spawned[0]!.args).not.toContain("--plugin-dir");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(f.output.join("")).toContain("existing Jevusher installation");
  });

  it.each(["missing-guard", "narrow-native-matcher"])("refuses incompatible existing hooks: %s", async kind => {
    const { provider, requests } = decision(); const f = await fixture(provider); const value = hooks();
    if (kind === "missing-guard") delete (value.hooks as Partial<typeof value.hooks>).PreToolUse;
    else value.hooks.PostToolUse[0]!.matcher = "^(Read|mcp__.*)$";
    await f.settings(value);
    await expect(launchClaude(["Task"], f.dependencies)).rejects.toThrow(/Re-run jevusher install/);
    expect(requests).toHaveLength(0); expect(f.spawned).toHaveLength(0);
  });

  it.each([["--setting-sources", ""], ["--setting-sources="], ["--restricted"]])("ignores disabled personal settings with %j", async (...options) => {
    const f = await fixture(); await f.settings(hooks());
    await launchClaude(["Task", "--", ...options], f.dependencies);
    expect(f.spawned[0]!.args).toContain("--plugin-dir");
  });

  it("honors explicit settings overlays even in restricted mode", async () => {
    const f = await fixture();
    await launchClaude(["Task", "--", "--restricted", "--settings", JSON.stringify(hooks())], f.dependencies);
    expect(f.spawned[0]!.args).not.toContain("--plugin-dir");
  });

  it("preserves an installed plugin and explains that its installed version must be updated", async () => {
    const f = await fixture(); await f.settings({ enabledPlugins: { "jevusher@example": true } });
    await launchClaude(["Task"], f.dependencies);
    expect(f.spawned[0]!.args).not.toContain("--plugin-dir");
    expect(f.output.join("")).toContain("Update it after upgrades");
  });

  it.each([
    [], [""], ["one", "two"], ["--unknown", "Task"], ["--model", "Task"],
    ["--model", "sonnet", "Task", "--", "--model", "opus"],
    ["Task", "--", "--model="], ["Task", "--", "--", "other"], ["Task", "--", "bad\0argument"],
  ])("rejects malformed arguments %j before routing or spawning", async (...argv) => {
    const { provider, requests } = decision(); const f = await fixture(provider);
    await expect(launchClaude(argv, f.dependencies)).rejects.toThrow();
    expect(requests).toHaveLength(0); expect(f.spawned).toHaveLength(0);
  });

  it("reports missing build before any JEV call", async () => {
    const { provider, requests } = decision(); const f = await fixture(provider);
    await rm(join(f.packageRoot, "dist", "hook.js"));
    await expect(launchClaude(["Task"], f.dependencies)).rejects.toThrow(/npm run build/);
    expect(requests).toHaveLength(0);
  });

  it.each([[7, null, 7], [null, "SIGTERM", 143]])("returns the child exit status (%s, %s)", async (code, signal, expected) => {
    const f = await fixture();
    f.dependencies.spawn = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", code, signal)); return child as ChildProcess; };
    expect(await launchClaude(["--no-route", "Task"], f.dependencies)).toBe(expected);
  });

  it.each([true, false])("returns 127 safely when Claude cannot start (synchronous=%s)", async synchronous => {
    const f = await fixture();
    f.dependencies.spawn = () => {
      if (synchronous) throw new Error("private error data");
      const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("private error data"))); return child as ChildProcess;
    };
    expect(await launchClaude(["--no-route", "Task"], f.dependencies)).toBe(127);
    expect(f.output.join("")).not.toContain("private error data");
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.signals.listenerCount("SIGHUP")).toBe(0);
  });

  it.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("forwards parent-only %s once and cleans up listeners", async (signal, expected) => {
    vi.useFakeTimers();
    const f = await fixture();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), exitCode: null, signalCode: null });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.dependencies.spawn = () => { started(); return child as unknown as ChildProcess; };
    const unrelated = vi.fn(); f.signals.on("SIGTERM", unrelated);
    const pending = launchClaude(["--no-route", "Task"], f.dependencies);
    await ready;
    f.signals.emit(signal); f.signals.emit(signal); f.signals.emit(signal === "SIGTERM" ? "SIGHUP" : "SIGTERM");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    child.emit("close", null, signal);
    expect(await pending).toBe(expected);
    expect(f.signals.listeners("SIGTERM")).toEqual([unrelated]);
    expect(f.signals.listenerCount("SIGHUP")).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("force-stops a child that does not exit after the forwarded termination", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), exitCode: null, signalCode: null });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.dependencies.spawn = () => { started(); return child as unknown as ChildProcess; };
    const pending = launchClaude(["--no-route", "Task"], f.dependencies);
    await ready;
    f.signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    child.emit("close", null, "SIGKILL");
    expect(await pending).toBe(137);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
    expect(f.signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("does not signal an exited child while close is pending", async () => {
    const f = await fixture();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true), exitCode: 0, signalCode: null });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.dependencies.spawn = () => { started(); return child as unknown as ChildProcess; };
    const pending = launchClaude(["--no-route", "Task"], f.dependencies);
    await ready;
    f.signals.emit("SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    expect(await pending).toBe(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  });
});
