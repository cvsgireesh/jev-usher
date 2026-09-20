import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevUsher, Jevusher, JevUsherError, JevusherError, type JevUsherConfig } from "../src/index.js";
import { jevusherHome, ledgerPath, loadMemory, readJsonl } from "../src/store.js";
import { stub } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("rename compatibility", () => {
  it("keeps constructor and error identity across the new and previous SDK names", () => {
    const config: JevUsherConfig = { provider: stub(() => ({})) };
    expect(JevUsher).toBe(Jevusher);
    expect(new JevUsher(config)).toBeInstanceOf(Jevusher);
    expect(JevUsherError).toBe(JevusherError);
    const cause = new Error("original cause");
    const error = new JevUsherError("test error", cause);
    expect(error).toBeInstanceOf(JevusherError);
    expect(error.name).toBe("JevusherError");
    expect(error.cause).toBe(cause);
  });

  it("reads existing private state in its original default directory without moving it", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-usher-compatibility-"));
    directories.push(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("JEVUSHER_HOME", undefined);
    vi.stubEnv("JEVUSHER_MEMORY", undefined);
    vi.stubEnv("JEVUSHER_LEDGER", undefined);
    const original = join(home, ".claude", "jevusher");
    await mkdir(original, { recursive: true, mode: 0o700 });
    const memory = '{"id":"existing-memory","text":"Retain this user record."}\n';
    const ledger = '{"lens":"hook-filter","offered":200,"admitted":100}\n';
    await writeFile(join(original, "memory.jsonl"), memory, { mode: 0o600 });
    await writeFile(join(original, "ledger.jsonl"), ledger, { mode: 0o600 });
    expect(jevusherHome()).toBe(original);
    expect(ledgerPath()).toBe(join(original, "ledger.jsonl"));
    expect(await loadMemory()).toEqual([{ id: "existing-memory", text: "Retain this user record." }]);
    expect(await readJsonl(ledgerPath())).toEqual([{ lens: "hook-filter", offered: 200, admitted: 100 }]);
    expect(await readFile(join(original, "memory.jsonl"), "utf8")).toBe(memory);
    expect(await readFile(join(original, "ledger.jsonl"), "utf8")).toBe(ledger);
  });
});
