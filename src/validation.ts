import type { Candidate, SystemOneRequest, SystemOneResponse } from "./types.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredText(value: unknown, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
}

export function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
}

export function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer >= ${minimum}`);
}

export function threshold(value: number, name: string): void {
  if (!probability(value)) throw new RangeError(`${name} must be between 0 and 1`);
}

export function ids(items: { id: string }[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() || seen.has(item.id)) {
      throw new TypeError("Every item needs a non-empty, unique id");
    }
    seen.add(item.id);
  }
}

export function candidates(items: Candidate[]): void {
  if (!Array.isArray(items)) throw new TypeError("candidates must be an array");
  ids(items);
  for (const item of items) {
    if (typeof item.text !== "string") throw new TypeError("candidate text must be a string");
    if (item.tokens !== undefined) nonNegative(item.tokens, "candidate tokens");
  }
}

/** Validate the HTTP boundary. A type assertion is not response validation. */
export function validateResponse(value: unknown, request: SystemOneRequest): SystemOneResponse {
  if (!record(value) || typeof value.model !== "string" || !record(value.answers) || !record(value.usage)) {
    throw new TypeError("Malformed Jev response envelope");
  }
  for (const key of ["input_tokens", "output_tokens"]) {
    const n = value.usage[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new TypeError("Malformed Jev usage");
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = value.answers[id];
    if (!record(answer) || answer.type !== question.type) throw new TypeError(`Missing or invalid Jev answer: ${id}`);
    if (question.type === "noul") {
      if (!probability(answer.noul)) throw new TypeError(`Invalid Noul: ${id}`);
      continue;
    }
    if (!probability(answer.confidence) || !record(answer.probabilities)) throw new TypeError(`Invalid confidence: ${id}`);
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (Object.keys(answer.probabilities).length !== keys.length || keys.some(k => !probability((answer.probabilities as Record<string, unknown>)[k]))) {
      throw new TypeError(`Invalid distribution: ${id}`);
    }
    const sum = Object.values(answer.probabilities).reduce<number>((a, b) => a + (b as number), 0);
    if (Math.abs(sum - 1) > 0.02) throw new TypeError(`Invalid probability sum: ${id}`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) throw new TypeError(`Invalid choice: ${id}`);
    } else if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || !record(answer.legend)) {
      throw new TypeError(`Invalid score: ${id}`);
    }
  }
  return value as unknown as SystemOneResponse;
}
