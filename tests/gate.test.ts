import { describe, expect, it } from "vitest";
import { Gate, NONE, type Answer, type Capability } from "../src/index.js";
import { choice, noul, score, stub } from "./helpers.js";

const catalog: Capability[] = [
  { id: "pdf", name: "pdf", summary: "read and fill PDFs" },
  { id: "xlsx", name: "xlsx", summary: "spreadsheets" },
  { id: "git", name: "git", summary: "version control operations" },
];

/** Stage one ranks by table; stage two picks whatever `pick` says. */
function twoStage(ranks: Record<string, number>, pick: string, confidence = 0.9) {
  return stub((request): Record<string, Answer> => {
    if ("pick" in request.questions) {
      return { pick: choice(pick, confidence, { [pick]: confidence }) };
    }
    const state = request.state as { catalog: Capability[] };
    const answers: Record<string, Answer> = {};
    state.catalog.forEach((entry, position) => {
      answers[`r${position}`] = score(ranks[entry.id] ?? 0);
    });
    answers.need = noul(0.9);
    return answers;
  });
}

describe("Gate.select", () => {
  it("surfaces the capability stage two picks", async () => {
    const gate = new Gate({ provider: twoStage({ git: 2, pdf: 0.2, xlsx: 0.1 }, "git") });
    const result = await gate.select({ turn: "amend the last commit", catalog });
    expect(result.selected.map((c) => c.id)).toEqual(["git"]);
    expect(result.reason).toBe("selected");
    expect(result.ranked[0]?.capability.id).toBe("git");
  });

  it("surfaces nothing when stage two rejects the shortlist", async () => {
    const gate = new Gate({ provider: twoStage({ git: 1, pdf: 1, xlsx: 1 }, NONE) });
    const result = await gate.select({ turn: "what time is it", catalog });
    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("none-needed");
  });

  it("surfaces nothing when the need check says no capability applies", async () => {
    const gate = new Gate({
      provider: stub((request): Record<string, Answer> => {
        const state = request.state as { catalog: Capability[] };
        const answers: Record<string, Answer> = {};
        state.catalog.forEach((_, i) => (answers[`r${i}`] = score(2)));
        answers.need = noul(0.05);
        return answers;
      }),
    });
    const result = await gate.select({ turn: "hi", catalog });
    expect(result.reason).toBe("none-needed");
    expect(result.selected).toEqual([]);
  });

  it("fails CLOSED on low confidence, unlike the admission lenses", async () => {
    const gate = new Gate({ provider: twoStage({ git: 2 }, "git", 0.2) });
    const result = await gate.select({ turn: "x", catalog });
    expect(result.selected).toEqual([]);
    expect(result.reason).toBe("low-confidence");
  });

  it("honours failOpen when explicitly asked for", async () => {
    const gate = new Gate({ provider: twoStage({ git: 2, pdf: 0.1, xlsx: 0.1 }, "git", 0.2) });
    const result = await gate.select({ turn: "x", catalog, failOpen: true });
    expect(result.selected.map((c) => c.id)).toEqual(["git"]);
  });

  it("batches a large catalog and still ranks across batches", async () => {
    const big: Capability[] = Array.from({ length: 200 }, (_, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      summary: "x",
    }));
    const provider = twoStage({ s150: 2 }, "s150");
    const gate = new Gate({ provider });
    const result = await gate.select({ turn: "x", catalog: big, batchSize: 96 });
    expect(result.ranked[0]?.capability.id).toBe("s150");
    expect(result.requests).toBe(4); // 3 ranking batches + 1 stage two
  });

  it("returns empty for an empty catalog without calling out", async () => {
    const provider = twoStage({}, NONE);
    const gate = new Gate({ provider });
    const result = await gate.select({ turn: "x", catalog: [] });
    expect(result.reason).toBe("empty-catalog");
    expect(provider.requests).toHaveLength(0);
  });
});
