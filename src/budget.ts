import { integer, nonNegative } from "./validation.js";
import type { Candidate } from "./types.js";

/**
 * Rough token estimate: ~4 characters per token.
 *
 * Deliberately cheap and dependency-free. It is used only for budget packing,
 * which can substantially undercount code and non-English text. Pass `tokens` on a Candidate
 * when you have a real count from your tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function candidateTokens(candidate: Candidate): number {
  const tokens = candidate.tokens ?? estimateTokens(candidate.text);
  nonNegative(tokens, "candidate tokens");
  return tokens;
}

export function totalTokens(candidates: Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidateTokens(candidate), 0);
}

/** Split into chunks of at most `size`, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
  integer(size, "chunk size", 1);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** Bound candidate text as well as count. Oversized individual items remain intact;
 * the client refuses them and each lens applies its documented fallback. */
export function boundedChunks<T>(items: T[], size: number, state: (item: T) => unknown): T[][] {
  integer(size, "batchSize", 1);
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const cost = Buffer.byteLength(JSON.stringify(state(item)), "utf8");
    if (batch.length && (batch.length >= size || bytes + cost > 20_000)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(item); bytes += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
