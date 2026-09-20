import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
