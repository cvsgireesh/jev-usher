import { describe, expect, it } from "vitest";
import { Router, DEFAULT_TIERS } from "../src/index.js";
import { choice, noul, stub } from "./helpers.js";

describe("Router.route", () => {
  it("returns the chosen tier when confidence clears the floor", async () => {
    const router = new Router({
      provider: stub(() => ({ tier: choice("mechanical", 0.88), needs_files: noul(0.9), needs_tools: noul(0.7) })),
    });
    const result = await router.route({ turn: "rename getUser to fetchUser everywhere" });
    expect(result.tier.id).toBe("mechanical");
    expect(result.trusted).toBe(true);
    expect(result.needsFiles).toBe(0.9);
  });

  it("falls back to the last tier when confidence is low", async () => {
    const router = new Router({ provider: stub(() => ({ tier: choice("trivial", 0.2) })) });
    const result = await router.route({ turn: "something ambiguous", probeWork: false });
    expect(result.tier.id).toBe("hard");
    expect(result.raw).toBe("trivial");
    expect(result.trusted).toBe(false);
  });

  it("honours an explicit fallback tier", async () => {
    const router = new Router({ provider: stub(() => ({ tier: choice("trivial", 0.1) })) });
    const result = await router.route({ turn: "x", fallback: "judgement", probeWork: false });
    expect(result.tier.id).toBe("judgement");
  });

  it("falls back rather than throwing when the provider is down", async () => {
    const router = new Router({ provider: stub(() => ({}), { failWith: new Error("503") }) });
    const result = await router.route({ turn: "x" });
    expect(result.tier.id).toBe("hard");
    expect(result.confidence).toBeNull();
    expect(result.usage.input_tokens).toBe(0);
  });

  it("rejects a fallback that is not in the tier list", async () => {
    const router = new Router({ provider: stub(() => ({})) });
    await expect(router.route({ turn: "x", fallback: "nope" })).rejects.toThrow(/not in tiers/);
  });

  it("ships four default tiers covering haiku through opus", () => {
    expect(DEFAULT_TIERS.map((t) => t.id)).toEqual(["trivial", "mechanical", "judgement", "hard"]);
  });
});
