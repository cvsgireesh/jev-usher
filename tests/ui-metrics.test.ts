import { describe, expect, it } from "vitest";

// Import the browser's plain ESM module without requiring a generated declaration.
const { comparisonMetrics } = await import(
  new URL("../ui/metrics.js", import.meta.url).href
);

const usage = (input: number, output = 100, read = 200, write = 100) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});
const checks = (...passed: boolean[]) => passed.map((value) => ({ passed: value }));
const comparison = () => ({
  baseline: { usage: usage(600), latencyMs: 2000, checks: checks(true, true) },
  filtered: { usage: usage(300), latencyMs: 1000, checks: checks(true, true) },
  routing: { latencyMs: 100 },
  jev: { costUsd: 0.0001, status: "available" },
  verdict: { passed: true },
});

describe("whole-run comparison metrics", () => {
  it("counts all reported token categories and includes routing time once", () => {
    const result = { ...comparison(), jev: { costUsd: 0.0001, status: "available", latencyMs: 900 } };
    const metrics = comparisonMetrics(result);
    expect(metrics.tokens).toEqual({ before: 1000, after: 700, saved: 300, percent: 30, tone: "benefit" });
    expect(metrics.time).toEqual({ before: 2000, after: 1100, saved: 900, percent: 45, tone: "benefit" });
    expect(metrics.quality).toEqual({ baselinePassed: 2, baselineTotal: 2, filteredPassed: 2, filteredTotal: 2, passed: true });
    expect(metrics.jevCost).toBe(0.0001);
  });

  it("shows worse whole-run usage when recovery outweighs the initial excerpt reduction", () => {
    const result = {
      ...comparison(),
      filtered: { usage: usage(100, 200, 1100, 100), latencyMs: 2500, checks: checks(true, true) },
      admission: { offeredTokens: 900, admittedTokens: 90, recoveredTokens: 1000 },
    };
    const metrics = comparisonMetrics(result);
    expect(metrics.tokens).toEqual({ before: 1000, after: 1500, saved: -500, percent: -50, tone: "worse" });
    expect(metrics.time).toEqual({ before: 2000, after: 2600, saved: -600, percent: -30, tone: "worse" });
  });

  it("does not double-count context hooks and does not assume missing routing latency is zero", () => {
    const result = comparison();
    expect(comparisonMetrics({ ...result, routing: undefined }).time.after).toBe(1000);
    expect(comparisonMetrics({ ...result, routing: null }).time.after).toBe(1000);
    expect(comparisonMetrics({ ...result, routing: {} }).time).toEqual({ before: 2000, after: null, saved: null, percent: null, tone: "unknown" });
    expect(comparisonMetrics({ ...result, routing: { latencyMs: 1500 } }).time.tone).toBe("worse");
  });

  it.each(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])("keeps token totals unknown when %s is absent", (field) => {
    const result = comparison();
    const incomplete = Object.fromEntries(Object.entries(result.filtered.usage).filter(([key]) => key !== field));
    const metrics = comparisonMetrics({ ...result, filtered: { ...result.filtered, usage: incomplete } });
    expect(metrics.tokens).toEqual({ before: 1000, after: null, saved: null, percent: null, tone: "unknown" });
  });

  it.each([null, undefined, -1, NaN, Infinity, "100"])("does not coerce invalid measurements (%s) into numbers", (invalid) => {
    const result = comparison();
    const metrics = comparisonMetrics({
      ...result,
      baseline: { ...result.baseline, latencyMs: invalid, usage: { ...result.baseline.usage, inputTokens: invalid } },
      jev: { costUsd: invalid, status: "available" },
    });
    expect(metrics.tokens.before).toBeNull();
    expect(metrics.time.before).toBeNull();
    expect(metrics.tokens.tone).toBe("unknown");
    expect(metrics.time.percent).toBeNull();
    expect(metrics.jevCost).toBeNull();
  });

  it("keeps genuine zeros and equal measurements neutral without dividing by zero", () => {
    const result = { ...comparison(), baseline: { usage: usage(0, 0, 0, 0), latencyMs: 0, checks: checks(true) }, filtered: { usage: usage(0, 0, 0, 0), latencyMs: 0, checks: checks(true) }, routing: undefined, jev: { costUsd: 0, status: "not-needed" } };
    const metrics = comparisonMetrics(result);
    expect(metrics.tokens).toEqual({ before: 0, after: 0, saved: 0, percent: null, tone: "neutral" });
    expect(metrics.time).toEqual(metrics.tokens);
    expect(metrics.jevCost).toBe(0);
    expect(comparisonMetrics({ ...result, filtered: { ...result.filtered, latencyMs: 100 } }).time).toEqual({ before: 0, after: 100, saved: -100, percent: null, tone: "worse" });
  });

  it("never colors reductions as benefits when either answer fails literal checks", () => {
    for (const variant of ["baseline", "filtered"] as const) {
      const result = comparison();
      result[variant].checks = checks(true, false);
      const metrics = comparisonMetrics(result);
      expect(metrics.quality.passed).toBe(false);
      expect(metrics.tokens.saved).toBe(300);
      expect(metrics.tokens.tone).toBe("neutral");
      expect(metrics.time.tone).toBe("neutral");
      expect(metrics.quality[`${variant}Passed`]).toBe(1);
    }
  });

  it.each([false, null, undefined])("requires an affirmative overall verdict (%s)", (passed) => {
    const metrics = comparisonMetrics({ ...comparison(), verdict: { passed } });
    expect(metrics.quality.passed).toBe(passed === false ? false : null);
    expect(metrics.tokens.tone).toBe("neutral");
    expect(metrics.time.tone).toBe("neutral");
  });

  it.each([undefined, [], [{ passed: "true" }], [{ passed: true }, {}]])("keeps missing or malformed check evidence unknown (%j)", (missing) => {
    const result = comparison();
    const metrics = comparisonMetrics({ ...result, baseline: { ...result.baseline, checks: missing } });
    expect(metrics.quality).toEqual({ baselinePassed: null, baselineTotal: null, filteredPassed: 2, filteredTotal: 2, passed: null });
    expect(metrics.tokens.tone).toBe("neutral");
  });

  it("does not report partial provider cost as the complete cost during an outage", () => {
    expect(comparisonMetrics({ ...comparison(), jev: { costUsd: 0.001, status: "unavailable" } }).jevCost).toBeNull();
    expect(comparisonMetrics({ ...comparison(), jev: undefined }).jevCost).toBeNull();
  });

  it("returns unknowns for a missing comparison and never mutates its input", () => {
    expect(comparisonMetrics(null)).toEqual({
      tokens: { before: null, after: null, saved: null, percent: null, tone: "unknown" },
      time: { before: null, after: null, saved: null, percent: null, tone: "unknown" },
      quality: { baselinePassed: null, baselineTotal: null, filteredPassed: null, filteredTotal: null, passed: null },
      jevCost: null,
    });
    const result = comparison();
    const original = structuredClone(result);
    comparisonMetrics(result);
    expect(result).toEqual(original);
  });
});
