import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jevusher-doctor-"));
  vi.stubEnv("JEVUSHER_HOME", home);
  vi.stubEnv("JEVUSHER_MEMORY", join(home, "memory.jsonl"));
  vi.stubEnv("JEVUSHER_CATALOG", join(home, "catalog.jsonl"));
  vi.stubEnv("JEVUSHER_LEDGER", join(home, "ledger.jsonl"));
  vi.stubEnv("JEV_API_KEY", "dummy-test-key");
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

describe("doctor", () => {
  it("reports failure and exits nonzero for rejected credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["doctor"])).toBe(1);
    expect(write.mock.calls.flat().join("")).toContain("connectivity: FAILED");
    expect(write.mock.calls.flat().join("")).not.toContain("connectivity: ok");
  });
  it("requires a validated live response before reporting healthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ model: "jev-1.13.0", answers: { greeting: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0 } })));
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["doctor"])).toBe(0);
    expect(write.mock.calls.flat().join("")).toContain("connectivity: ok");
  });
  it("ignores invalid ledger records without breaking report", async () => {
    await writeFile(join(home, "ledger.jsonl"), "null\n[]\n{}\n");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["report"])).toBe(0);
  });
});

describe("global settings installation", () => {
  it.each([true, false])("installs and uninstalls in Claude's configured directory (override=%s)", async override => {
    const fixtureHome = join(home, "isolated home");
    const defaultRoot = join(fixtureHome, ".claude");
    const customRoot = join(home, "custom Claude config");
    await Promise.all([mkdir(defaultRoot, { recursive: true }), mkdir(customRoot)]);
    vi.stubEnv("HOME", fixtureHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", override ? customRoot : undefined);
    const original = { permissions: { deny: ["Bash(rm *)"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "unrelated-hook" }] }] } };
    const target = join(override ? customRoot : defaultRoot, "settings.json");
    const untouched = join(override ? defaultRoot : customRoot, "settings.json");
    await writeFile(target, JSON.stringify(original));
    await writeFile(untouched, '{"untouched":true}');
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await main(["install", "--global"])).toBe(0);
    const installed = JSON.parse(await readFile(target, "utf8"));
    expect(installed.permissions).toEqual(original.permissions);
    expect(installed.hooks.UserPromptSubmit).toHaveLength(2);
    expect(installed.hooks.PreToolUse[0].matcher).toBe("^(Edit|Write)$");
    expect(installed.hooks.PostToolUse[0].matcher).toContain("Bash");
    expect(installed.hooks.PostToolUse[0].hooks[0].command).toContain("bin/jev-usher.mjs");
    expect(await main(["uninstall", "--global"])).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(original);
    expect(await readFile(untouched, "utf8")).toBe('{"untouched":true}');
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("advertises the new command while retaining the existing configuration namespace", async () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(await main(["--help"])).toBe(0);
  const help = write.mock.calls.flat().join("");
  expect(help).toContain("jev-usher claude");
  expect(help).toContain("JEVUSHER_HOME      default ~/.claude/jevusher");
  expect(help).not.toContain("jevusher claude");
});
