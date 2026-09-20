import { describe, expect, it } from "vitest";
import { Compactor, type Candidate } from "../src/index.js";
import { choice, stub } from "./helpers.js";

const blocks: Candidate[] = [
  { id: "b1", text: "decision", tokens: 100 },
  { id: "b2", text: "chatter", tokens: 100 },
  { id: "b3", text: "error", tokens: 100 },
];

function triageStub(table: Record<string, [string, number]>) {
  return stub((request) => {
    const state = request.state as { blocks: Candidate[] };
    const answers: Record<string, ReturnType<typeof choice>> = {};
    state.blocks.forEach((block, position) => {
      const [disposition, confidence] = table[block.id] ?? ["shorten", 0.9];
      answers[`b${position}`] = choice(disposition, confidence);
    });
    return answers;
  });
}

describe("Compactor.triage", () => {
  it("sorts blocks into keep, summarize and drop", async () => {
    const compactor = new Compactor({
      provider: triageStub({ b1: ["keep", 0.9], b2: ["drop", 0.9], b3: ["keep", 0.9] }),
    });
    const result = await compactor.triage({ goal: "fix the bug", blocks });
    expect(result.keep.map((b: { id: string }) => b.id)).toEqual(["b1", "b3"]);
    expect(result.drop.map((b: { id: string }) => b.id)).toEqual(["b2"]);
    expect(result.tokensKept).toBe(200);
    expect(result.tokensBefore).toBe(300);
  });

  it("demotes keeps to summarize once the verbatim budget is spent", async () => {
    const compactor = new Compactor({
      provider: triageStub({ b1: ["keep", 0.9], b2: ["keep", 0.9], b3: ["keep", 0.9] }),
    });
    const result = await compactor.triage({ goal: "g", blocks, keepBudget: 150 });
    expect(result.keep.map((b: { id: string }) => b.id)).toEqual(["b1"]);
    expect(result.shortened.map((b: { id: string }) => b.id)).toEqual(["b2", "b3"]);
  });

  it("never drops a block it was unsure about", async () => {
    const compactor = new Compactor({ provider: triageStub({ b1: ["drop", 0.1] }) });
    const result = await compactor.triage({ goal: "g", blocks: [blocks[0]!] });
    expect(result.drop).toHaveLength(0);
    expect(result.shortened.map((b: { id: string }) => b.id)).toEqual(["b1"]);
  });

  it("shortens by cutting, never by rewriting", async () => {
    const long = "PATH=/etc/app/config.yml raised ENOENT. " + "detail ".repeat(200);
    const compactor = new Compactor({ provider: triageStub({ b1: ["shorten", 0.9] }) });
    const result = await compactor.triage({
      goal: "g",
      blocks: [{ id: "b1", text: long }],
      headChars: 60,
    });
    const text = result.shortened[0]!.text;
    expect(long.startsWith(text.split("\n[...")[0]!)).toBe(true);
    expect(text).toContain("characters removed");
    expect(text.length).toBeLessThan(long.length);
  });

  it("makes no second model call: its only cost is Jev", async () => {
    const provider = triageStub({ b1: ["shorten", 0.9], b2: ["shorten", 0.9], b3: ["drop", 0.9] });
    const compactor = new Compactor({ provider });
    await compactor.triage({ goal: "g", blocks });
    expect(provider.requests).toHaveLength(1);
  });

  it("preserves transcript order within keep", async () => {
    const compactor = new Compactor({
      provider: triageStub({ b1: ["keep", 0.9], b2: ["shorten", 0.9], b3: ["keep", 0.9] }),
    });
    const result = await compactor.triage({ goal: "g", blocks });
    expect(result.keep.map((b: { id: string }) => b.id)).toEqual(["b1", "b3"]);
  });

  it("keeps everything rather than shrinking a transcript blind", async () => {
    const compactor = new Compactor({ provider: stub(() => ({}), { failWith: new Error("502") }) });
    const result = await compactor.triage({ goal: "g", blocks });
    expect(result.drop).toHaveLength(0);
    expect(result.shortened).toHaveLength(0);
    expect(result.keep).toHaveLength(3);
  });

  it("throws instead of guessing when failOpen is off", async () => {
    const compactor = new Compactor({ provider: stub(() => ({}), { failWith: new Error("502") }) });
    await expect(compactor.triage({ goal: "g", blocks, failOpen: false })).rejects.toThrow();
  });
});
