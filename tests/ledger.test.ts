import { describe, expect, it } from "vitest";
import { Ledger } from "../src/index.js";

const usage = { input_tokens: 1000, output_tokens: 0 };

describe("Ledger", () => {
  it("totals offered, admitted and saved across lenses", () => {
    const ledger = new Ledger();
    ledger.record("memory", { offered: 10_000, admitted: 2_000, jevUsage: usage, requests: 1 });
    ledger.record("tool-result", { offered: 30_000, admitted: 4_000, jevUsage: usage, requests: 2 });
    const report = ledger.report();
    expect(report.offered).toBe(40_000);
    expect(report.admitted).toBe(6_000);
    expect(report.saved).toBe(34_000);
    expect(report.requests).toBe(3);
    expect(report.byLens.memory?.offered).toBe(10_000);
  });

  it("prices the saving net of what Jev cost to read", () => {
    const ledger = new Ledger({ jev: 0.042, target: 15 });
    ledger.record("memory", { offered: 1_000_000, admitted: 0, jevUsage: { input_tokens: 1_000_000, output_tokens: 0 }, requests: 1 });
    const report = ledger.report();
    expect(report.cost.targetWithout).toBeCloseTo(15);
    expect(report.cost.jev).toBeCloseTo(0.042);
    expect(report.cost.net).toBeCloseTo(14.958);
  });

  it("can report a negative net, and does not hide it", () => {
    const ledger = new Ledger({ jev: 0.042, target: 15 });
    // Everything admitted anyway: Jev read the material for no reduction.
    ledger.record("memory", { offered: 100, admitted: 100, jevUsage: { input_tokens: 500_000, output_tokens: 0 }, requests: 1 });
    expect(ledger.report().cost.net).toBeLessThan(0);
  });

  it("clears", () => {
    const ledger = new Ledger();
    ledger.record("x", { offered: 1, admitted: 1, jevUsage: usage, requests: 1 });
    ledger.clear();
    expect(ledger.length).toBe(0);
  });
});
