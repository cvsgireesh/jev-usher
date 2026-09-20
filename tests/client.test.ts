import { describe, expect, it, vi } from "vitest";
import { JevClient, type SystemOneRequest } from "../src/index.js";

const request: SystemOneRequest = { model: "jev-1.13.0", state: "hello", questions: {
  greeting: { type: "noul", instructions: "Is this a greeting?" },
} };
const valid = { model: "jev-1.13.0", answers: { greeting: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 30, output_tokens: 0 } };

describe("Jev HTTP boundary", () => {
  it("sends the documented wire contract and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(valid));
    const client = new JevClient({ apiKey: "dummy-test-key", fetch: fetcher });
    expect(await client.evaluate(request)).toEqual(valid);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(init!.body as string)).toEqual(request);
    expect(init?.redirect).toBe("error");
  });

  it.each([{}, { ...valid, answers: {} }, { ...valid, answers: { greeting: { type: "noul", noul: 2 } } },
    { ...valid, usage: { input_tokens: -1, output_tokens: 0 } }])("rejects malformed responses without retries", async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate(request)).rejects.toThrow("Malformed Jev response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry an authentication failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate(request)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries provider overload and honors retry-after", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("overloaded", { status: 529, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(Response.json(valid));
    expect(await new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate(request)).toEqual(valid);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds long retry-after delays", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("wait", { status: 429, headers: { "retry-after": "3600" } }));
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate(request)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled transport", async () => {
    const fetcher: typeof fetch = (_, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher, timeoutMs: 10, maxRetries: 0 }).evaluate(request)).rejects.toThrow("aborted");
  });

  it.each([{ maxRetries: -1 }, { timeoutMs: 0 }, { maxRetries: NaN }])("rejects invalid transport configuration", config => {
    expect(() => new JevClient({ apiKey: "dummy", ...config })).toThrow(RangeError);
  });

  it("refuses oversized state before any network request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate({ ...request, state: "界".repeat(12_000) })).rejects.toThrow("byte budget");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a choice outside the supplied criteria", async () => {
    const question: SystemOneRequest = { ...request, questions: { pick: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } } } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...valid, answers: { pick: {
      type: "choice", choice: "unknown", confidence: 0.99, probabilities: { a: 0.99, b: 0.01 },
    } } }));
    await expect(new JevClient({ apiKey: "dummy", fetch: fetcher }).evaluate(question)).rejects.toThrow("Malformed Jev response");
  });
});
