import type { Candidate } from "./types.js";

/**
 * Rough token estimate: ~4 characters per token.
 *
 * Deliberately cheap and dependency-free. It is used only for budget packing,
 * where being a few percent off changes nothing. Pass `tokens` on a Candidate
 * when you have a real count from your tokenizer.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function candidateTokens(candidate: Candidate): number {
  return candidate.tokens ?? estimateTokens(candidate.text);
}

export function totalTokens(candidates: Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidateTokens(candidate), 0);
}

/** Split into chunks of at most `size`, preserving order. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError("chunk size must be positive");
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
