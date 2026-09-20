import { describe, expect, it } from "vitest";
import { Usher } from "../src/usher.js";
import type { Candidate, Provider, ScoreAnswer, SystemOneRequest, SystemOneResponse } from "../src/index.js";

/** Scores candidates from a lookup table so admission logic can be tested exactly. */
function stubProvider(
  table: Record<string, { score: number; confidence: number }>,
  options: { need?: number; failWith?: Error } = {},
): Provider & { requests: SystemOneRequest[] } {
  const requests: SystemOneRequest[] = [];
  return {
    model: "stub",
    requests,
    async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
      if (options.failWith) throw options.failWith;
      requests.push(request);
      const state = request.state as { candidates: Candidate[] };
      const answers: Record<string, ScoreAnswer | { type: "noul"; noul: number }> = {};
      state.candidates.forEach((candidate, position) => {
        const entry = table[candidate.id] ?? { score: 0, confidence: 1 };
        answers[`c${position}`] = {
          type: "score",
          score: entry.score,
          confidence: entry.confidence,
          legend: { "0": "irrelevant", "1": "background", "2": "needed" },
          probabilities: { "0": 0, "1": 0, "2": 1 },
        };
      });
      if (options.need !== undefined && "need" in request.questions) {
        answers.need = { type: "noul", noul: options.need };
      }
      return {
        model: "stub",
        answers: answers as SystemOneResponse["answers"],
        usage: { input_tokens: 100, output_tokens: 0 },
      };
    },
  };
}

const candidates: Candidate[] = [
  { id: "a", text: "x".repeat(400), tokens: 100 },
  { id: "b", text: "y".repeat(400), tokens: 100 },
  { id: "c", text: "z".repeat(400), tokens: 100 },
];

describe("Usher.admit", () => {
  it("admits only candidates at or above the threshold", async () => {
    const usher = new Usher({
      provider: stubProvider({
        a: { score: 2.0, confidence: 0.9 },
        b: { score: 0.2, confidence: 0.9 },
        c: { score: 1.6, confidence: 0.9 },
      }),
    });
    const result = await usher.admit({ goal: "fix the login bug", candidates, checkNeed: false });
    expect(result.admitted.map((c) => c.id)).toEqual(["a", "c"]);
    expect(result.verdicts.find((v) => v.id === "b")?.reason).toBe("below-threshold");
    expect(result.tokensAdmitted).toBe(200);
    expect(result.tokensOffered).toBe(300);
  });

  it("orders by score and stops at the budget", async () => {
    const usher = new Usher({
      provider: stubProvider({
        a: { score: 1.7, confidence: 0.9 },
        b: { score: 2.0, confidence: 0.9 },
        c: { score: 1.9, confidence: 0.9 },
      }),
    });
    const result = await usher.admit({ goal: "g", candidates, budget: 200, checkNeed: false });
    expect(result.admitted.map((c) => c.id)).toEqual(["b", "c"]);
    expect(result.verdicts.find((v) => v.id === "a")?.reason).toBe("over-budget");
  });

  it("fails open on low confidence by default", async () => {
    const usher = new Usher({
      provider: stubProvider({
        a: { score: 0.1, confidence: 0.2 },
        b: { score: 0.1, confidence: 0.9 },
        c: { score: 0.1, confidence: 0.9 },
      }),
    });
    const result = await usher.admit({ goal: "g", candidates, checkNeed: false });
    expect(result.admitted.map((c) => c.id)).toEqual(["a"]);
    expect(result.verdicts.find((v) => v.id === "a")?.reason).toBe("low-confidence-admitted");
  });

  it("turns low-confidence candidates away when failOpen is off", async () => {
    const usher = new Usher({
      provider: stubProvider({ a: { score: 2, confidence: 0.2 } }),
    });
    const result = await usher.admit({
      goal: "g",
      candidates: [candidates[0]!],
      failOpen: false,
      checkNeed: false,
    });
    expect(result.admitted).toHaveLength(0);
    expect(result.verdicts[0]?.reason).toBe("low-confidence-turned-away");
  });

  it("turns everyone away when the goal needs no context", async () => {
    const usher = new Usher({
      provider: stubProvider({ a: { score: 2, confidence: 0.9 } }, { need: 0.02 }),
    });
    const result = await usher.admit({ goal: "what is 2+2", candidates });
    expect(result.admitted).toHaveLength(0);
    expect(result.need).toBe(0.02);
    expect(result.verdicts.every((v) => v.reason === "goal-needs-no-context")).toBe(true);
  });

  it("keeps everyone when the goal does need context", async () => {
    const usher = new Usher({
      provider: stubProvider({ a: { score: 2, confidence: 0.9 } }, { need: 0.95 }),
    });
    const result = await usher.admit({ goal: "g", candidates: [candidates[0]!] });
    expect(result.admitted.map((c) => c.id)).toEqual(["a"]);
  });

  it("batches large candidate sets into parallel requests", async () => {
    const provider = stubProvider({});
    const many: Candidate[] = Array.from({ length: 150 }, (_, i) => ({
      id: `k${i}`,
      text: "t",
      tokens: 1,
    }));
    const usher = new Usher({ provider });
    const result = await usher.admit({ goal: "g", candidates: many, batchSize: 64, checkNeed: false });
    expect(result.requests).toBe(3);
    expect(provider.requests.every((r) => Object.keys(r.questions).length <= 64)).toBe(true);
  });

  it("admits everything when the provider fails and failOpen is on", async () => {
    const usher = new Usher({ provider: stubProvider({}, { failWith: new Error("502") }) });
    const result = await usher.admit({ goal: "g", candidates, budget: 200 });
    expect(result.admitted.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.verdicts[0]?.reason).toBe("provider-error-admitted");
    expect(result.jevUsage.input_tokens).toBe(0);
  });

  it("rethrows provider failures when failOpen is off", async () => {
    const usher = new Usher({ provider: stubProvider({}, { failWith: new Error("502") }) });
    await expect(usher.admit({ goal: "g", candidates, failOpen: false })).rejects.toThrow("502");
  });

  it("handles an empty candidate list without calling the provider", async () => {
    const provider = stubProvider({});
    const usher = new Usher({ provider });
    const result = await usher.admit({ goal: "g", candidates: [] });
    expect(result.requests).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });
});
