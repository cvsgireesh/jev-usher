import { createHash } from "node:crypto";
import type { Provider } from "./client.js";
import type { SystemOneRequest, SystemOneResponse } from "./types.js";
import { integer, validateResponse } from "./validation.js";

export interface DecisionCacheOptions {
  /** Maximum completed decisions retained. Default 128. */
  maxEntries?: number;
  /** Maximum age after a successful response. Default 60 seconds. */
  ttlMs?: number;
}

/** Exact-request memoization for a long-lived, caller-scoped provider.
 * No persistence, redaction, fuzzy matching, shared cache, or network service.
 * Cache hits return zero incremental usage; the first response retains usage.
 */
export class DecisionCache implements Provider {
  readonly model: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, { expires: number; response: SystemOneResponse }>();
  private generation = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly provider: Provider, options: DecisionCacheOptions = {}) {
    this.model = provider.model;
    this.maxEntries = options.maxEntries ?? 128;
    this.ttlMs = options.ttlMs ?? 60_000;
    integer(this.maxEntries, "maxEntries", 1);
    integer(this.ttlMs, "ttlMs", 1);
    // A moving alias can serve different weights without changing the request.
    if (!/^jev-\d+\.\d+\.\d+$/.test(this.model)) throw new Error("DecisionCache requires a pinned Jev version (e.g. jev-1.13.0)");
  }

  async evaluate(request: SystemOneRequest): Promise<SystemOneResponse> {
    if (request.model !== this.model) throw new Error("Request model does not match cached provider model");
    const generation = this.generation;
    const snapshot = structuredClone(request);
    const key = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now()) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { ...structuredClone(cached.response), usage: { input_tokens: 0, output_tokens: 0 } };
    }
    this.entries.delete(key);
    this.misses++;
    const response = validateResponse(await this.provider.evaluate(snapshot), snapshot);
    // Never persist an alias resolution or unexpected model as this pinned model.
    if (response.model !== this.model || generation !== this.generation) return response;
    const stored = structuredClone(response);
    this.entries.set(key, { expires: Date.now() + this.ttlMs, response: stored });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
      this.evictions++;
    }
    return response;
  }

  clear(): void { this.generation++; this.entries.clear(); }

  stats() {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, entries: this.entries.size };
  }
}
