import { describe, expect, it } from "vitest";
import { Jevusher, type Candidate, type Capability } from "../src/index.js";
import { choice, noul, score, stub } from "./helpers.js";

const memory: Candidate[] = [
  { id: "m1", text: "relevant", tokens: 100 },
  { id: "m2", text: "irrelevant", tokens: 100 },
];
const catalog: Capability[] = [
  { id: "git", name: "git", summary: "version control" },
  { id: "pdf", name: "pdf", summary: "pdfs" },
];

/** Routes by question shape, so one stub can serve the whole pipeline. */
const everything = stub((request) => {
  const questions = request.questions;
  if ("tier" in questions) {
    return { tier: choice("mechanical", 0.9), needs_files: noul(0.8), needs_tools: noul(0.6) };
  }
  if ("pick" in questions) return { pick: choice("git", 0.9, { git: 0.9 }) };
  const state = request.state as { catalog?: Capability[]; candidates?: Candidate[] };
  const answers: Record<string, ReturnType<typeof score> | ReturnType<typeof noul>> = {};
  if (state.catalog) {
    state.catalog.forEach((entry, i) => (answers[`r${i}`] = score(entry.id === "git" ? 2 : 0)));
    if ("need" in questions) answers.need = noul(0.9);
    return answers;
  }
  state.candidates?.forEach((candidate, i) => (answers[`c${i}`] = score(candidate.id === "m1" ? 2 : 0)));
  if ("need" in questions) answers.need = noul(0.9);
  return answers;
});

describe("Jevusher.beforeTurn", () => {
  it("routes, gates and admits in one pass", async () => {
    const jevusher = new Jevusher({ provider: everything });
    const result = await jevusher.beforeTurn({ turn: "amend the last commit", memory, catalog });
    expect(result.route?.tier.id).toBe("mechanical");
    expect(result.skills.map((s) => s.id)).toEqual(["git"]);
    expect(result.admitted.map((m) => m.id)).toEqual(["m1"]);
  });

  it("records every lens in the ledger", async () => {
    const jevusher = new Jevusher({ provider: everything });
    await jevusher.beforeTurn({ turn: "x", memory, catalog });
    const report = jevusher.report();
    expect(Object.keys(report.byLens).sort()).toEqual(["gate", "memory", "route"]);
    expect(report.byLens.memory?.offered).toBe(200);
    expect(report.byLens.memory?.admitted).toBe(100);
  });

  it("skips lenses it has no input for", async () => {
    const jevusher = new Jevusher({ provider: everything });
    const result = await jevusher.beforeTurn({ turn: "x" });
    expect(result.gate).toBeNull();
    expect(result.memory).toBeNull();
    expect(result.route).not.toBeNull();
  });

  it("skips routing on request", async () => {
    const jevusher = new Jevusher({ provider: everything });
    const result = await jevusher.beforeTurn({ turn: "x", skipRoute: true });
    expect(result.route).toBeNull();
    expect(result.requests).toBe(0);
  });

  it("exposes every lens for direct use", () => {
    const jevusher = new Jevusher({ provider: everything });
    for (const lens of ["router", "gate", "usher", "filter", "compactor", "stopGate", "screen"] as const) {
      expect(jevusher[lens]).toBeDefined();
    }
  });
});
