import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionCache } from "../src/cache.js";
import type { Provider, SystemOneRequest, SystemOneResponse } from "../src/index.js";

const model = "jev-1.13.0";
const request: SystemOneRequest = { model, state: { user: "user-42", deadline: "2026-10-01", amount: 100 }, questions: {
  valid: { type: "noul", instructions: "Is this a valid request?" },
} };
function fixture() {
  const response: SystemOneResponse = { model, answers: { valid: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 100, output_tokens: 0 } };
  const evaluate = vi.fn<Provider["evaluate"]>().mockImplementation(async () => structuredClone(response));
  return { evaluate, model };
}
afterEach(() => vi.useRealTimers());

describe("DecisionCache", () => {
  it("reuses exact decisions and accounts for incremental usage only", async () => {
    const provider = fixture(), cache = new DecisionCache(provider);
    const first = await cache.evaluate(request), repeat = await cache.evaluate(request);
    expect(repeat.answers).toEqual(first.answers);
    expect(first.usage.input_tokens).toBe(100);
    expect(repeat.usage.input_tokens).toBe(0);
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });
  it.each(["user", "deadline", "amount"])("does not erase decision-relevant %s from the key", async field => {
    const provider = fixture(), cache = new DecisionCache(provider);
    await cache.evaluate(request);
    await cache.evaluate({ ...request, state: { ...(request.state as object), [field]: "changed" } });
    expect(provider.evaluate).toHaveBeenCalledTimes(2);
  });
  it("invalidates when question wording changes", async () => {
    const provider = fixture(), cache = new DecisionCache(provider);
    await cache.evaluate(request);
    await cache.evaluate({ ...request, questions: { valid: { type: "noul", instructions: "Is this invalid?" } } });
    expect(provider.evaluate).toHaveBeenCalledTimes(2);
  });
  it("expires decisions and evicts least recently used entries", async () => {
    vi.useFakeTimers();
    const provider = fixture(), cache = new DecisionCache(provider, { ttlMs: 10, maxEntries: 1 });
    await cache.evaluate(request);
    vi.advanceTimersByTime(11);
    await cache.evaluate(request);
    await cache.evaluate({ ...request, state: "different" });
    await cache.evaluate(request);
    expect(provider.evaluate).toHaveBeenCalledTimes(4);
    expect(cache.stats().entries).toBe(1);
  });
  it("never caches failures or malformed responses", async () => {
    const provider = fixture(), cache = new DecisionCache(provider);
    provider.evaluate.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({} as SystemOneResponse);
    await expect(cache.evaluate(request)).rejects.toThrow("offline");
    await expect(cache.evaluate(request)).rejects.toThrow("Malformed");
    await cache.evaluate(request);
    expect(provider.evaluate).toHaveBeenCalledTimes(3);
  });
  it("isolates callers from mutations and supports explicit clearing", async () => {
    const cache = new DecisionCache(fixture());
    (await cache.evaluate(request)).answers = {};
    const second = await cache.evaluate(request);
    expect(second.answers.valid).toBeDefined();
    second.answers = {};
    expect((await cache.evaluate(request)).answers.valid).toBeDefined();
    cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
  it("rejects moving aliases and mismatched models", async () => {
    expect(() => new DecisionCache({ ...fixture(), model: "jev-latest" })).toThrow("pinned");
    const cache = new DecisionCache(fixture());
    await expect(cache.evaluate({ ...request, model: "jev-1.12.0" })).rejects.toThrow("match");
  });
  it("does not repopulate a cleared cache from an in-flight response", async () => {
    let finish!: (value: SystemOneResponse) => void;
    const provider = { model, evaluate: () => new Promise<SystemOneResponse>(resolve => { finish = resolve; }) };
    const cache = new DecisionCache(provider);
    const pending = cache.evaluate(request);
    cache.clear();
    finish({ model, answers: { valid: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0 } });
    await pending;
    expect(cache.stats().entries).toBe(0);
  });
});
