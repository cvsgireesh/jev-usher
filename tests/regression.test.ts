import { describe, expect, it } from "vitest";
import { Compactor, Filter, Gate, Screen, StopGate, Usher, chunk, type Answer, type Candidate } from "../src/index.js";
import { runBatches } from "../src/core.js";
import { choice, noul, score, stub } from "./helpers.js";

describe("failure and boundary regressions", () => {
  it("does not let an irrelevant first batch veto needed later memory", async () => {
    const provider = stub(request => {
      const rows = (request.state as { candidates: Candidate[] }).candidates;
      const needed = rows[0]!.id === "required";
      return { c0: score(needed ? 2 : 0), need: noul(needed ? 0.99 : 0.01) };
    });
    const result = await new Usher({ provider }).admit({ goal: "find the constraint", batchSize: 1, candidates: [
      { id: "noise", text: "unrelated" }, { id: "required", text: "constraint" },
    ] });
    expect(result.admitted.map(c => c.id)).toEqual(["required"]);
  });

  it.each([{}, { i0: noul(0) }, { i0: noul(NaN), j0: noul(0), h0: score(0) },
    { i0: noul(-1), j0: noul(0), h0: score(0) }])("never reports malformed screening answers as pass", async answers => {
    const result = await new Screen({ provider: stub(() => answers as Record<string, Answer>) }).check({ items: [{ id: "x", text: "x" }] });
    expect(result.passed).toEqual([]);
    expect(result.findings[0]?.verdict).toBe("unavailable");
  });

  it("does not stop with incomplete evidence", async () => {
    const result = await new StopGate({ provider: stub(() => ({ goal_met: noul(0.99) })) }).check({ goal: "g", work: "w" });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe("unavailable");
  });

  it("keeps uncertain compaction text even when over budget", async () => {
    const original = { id: "x", text: "x".repeat(2000) + " CRITICAL CONSTRAINT", tokens: 900 };
    const result = await new Compactor({ provider: stub(() => ({ b0: choice("drop", 0.1) })) }).triage({ goal: "g", blocks: [original], keepBudget: 1 });
    expect(result.retained).toEqual([original]);
    expect(result.tokensKept).toBe(900);
  });

  it("returns compacted blocks in original order with corrected token metadata", async () => {
    const result = await new Compactor({ provider: stub(() => ({ b0: choice("shorten"), b1: choice("keep"), b2: choice("drop") })) }).triage({
      goal: "g", blocks: [{ id: "a", text: "a".repeat(1000), tokens: 500 }, { id: "b", text: "b" }, { id: "c", text: "c" }],
    });
    expect(result.retained.map(c => c.id)).toEqual(["a", "b"]);
    expect(result.retained[0]!.tokens).toBeLessThan(500);
  });

  it("preserves text for an unknown compaction disposition", async () => {
    const block = { id: "a", text: "retain me" };
    const result = await new Compactor({ provider: stub(() => ({ b0: choice("invented") })) }).triage({ goal: "g", blocks: [block] });
    expect(result.keep).toEqual([block]);
  });

  it.each([NaN, Infinity, 0, -1, 0.5])("rejects invalid chunk sizes instead of losing data or hanging: %s", n => {
    expect(() => chunk([1, 2], n)).toThrow();
  });

  it("rejects duplicate ids and negative token costs", async () => {
    const usher = new Usher({ provider: stub(() => ({})) });
    await expect(usher.admit({ goal: "g", candidates: [{ id: "a", text: "x" }, { id: "a", text: "y" }] })).rejects.toThrow("unique");
    await expect(usher.admit({ goal: "g", candidates: [{ id: "a", text: "x", tokens: -1 }] })).rejects.toThrow("non-negative");
  });

  it("counts screened-out tokens and both requests", async () => {
    const provider = stub((r): Record<string, Answer> => "i0" in r.questions
      ? { i0: noul(0.99), j0: noul(0), h0: score(2), i1: noul(0), j1: noul(0), h1: score(0) }
      : { c0: score(2), need: noul(1) });
    const result = await new Filter({ provider }).apply({ goal: "g", source: "web", chunks: [
      { id: "evil", text: "hostile", tokens: 100 }, { id: "useful", text: "useful", tokens: 50 },
    ] });
    expect(result.tokensOffered).toBe(150);
    expect(result.tokensAdmitted).toBe(50);
    expect(result.requests).toBe(2);
  });

  it("does not select an unknown capability from a malformed choice", async () => {
    const provider = stub((r): Record<string, Answer> => "pick" in r.questions ? { pick: choice("unknown") } : { r0: score(2) });
    const result = await new Gate({ provider }).select({ turn: "g", catalog: [{ id: "known", name: "known", summary: "x" }] });
    expect(result.selected).toEqual([]);
  });

  it("bounds concurrent batches", async () => {
    let active = 0, peak = 0;
    const provider = { model: "stub", async evaluate() {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return { model: "stub", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    } };
    const requests = Array.from({ length: 20 }, () => ({ model: "stub", state: "", questions: {} }));
    expect(await runBatches(provider, requests)).toHaveLength(20);
    expect(peak).toBe(4);
  });

  it("splits long candidate text before reaching the count limit", async () => {
    const provider = stub(() => ({}));
    await new Usher({ provider }).admit({ goal: "g", checkNeed: false, candidates: Array.from({ length: 3 }, (_, i) => ({ id: String(i), text: "x".repeat(12_000) })) });
    expect(provider.requests).toHaveLength(3);
  });

  it("does not transmit material without a defined goal", async () => {
    const provider = stub(() => ({}));
    await expect(new Usher({ provider }).admit({ goal: "", candidates: [{ id: "a", text: "private material" }] })).rejects.toThrow("goal");
    expect(provider.requests).toHaveLength(0);
  });

  it("keeps caller metadata opaque during batching", async () => {
    const meta: Record<string, unknown> = {}; meta.self = meta;
    const provider = stub(() => ({ c0: score(2), need: noul(1) }));
    const result = await new Usher({ provider }).admit({ goal: "g", candidates: [{ id: "a", text: "evidence", meta }] });
    expect(result.admitted[0]?.meta).toBe(meta);
    expect((provider.requests[0]!.state as { candidates: unknown[] }).candidates).toEqual([{ id: "a", text: "evidence" }]);
  });
});
