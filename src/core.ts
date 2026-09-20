import { probability, record } from "./validation.js";
import type { Provider } from "./client.js";
import type {
  Answer,
  ChoiceAnswer,
  ScoreAnswer,
  SystemOneRequest,
  SystemOneResponse,
  Usage,
} from "./types.js";

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

/** Run prepared requests in parallel. */
export function runBatches(provider: Provider, requests: SystemOneRequest[]): Promise<SystemOneResponse[]> {
  return (async () => {
    const responses = new Array<SystemOneResponse>(requests.length);
    let next = 0;
    let failed = false;
    let error: unknown;
    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
      while (!failed && next < requests.length) {
        const index = next++;
        try { responses[index] = await provider.evaluate(requests[index]!); }
        catch (cause) { failed = true; error = cause; }
      }
    }));
    if (failed) throw error;
    return responses;
  })();
}

export function sumUsage(responses: SystemOneResponse[]): Usage {
  return responses.reduce<Usage>(
    (sum, response) => ({
      input_tokens: sum.input_tokens + (response.usage?.input_tokens ?? 0),
      output_tokens: sum.output_tokens + (response.usage?.output_tokens ?? 0),
    }),
    { ...ZERO_USAGE },
  );
}

export function asScore(answer: Answer | undefined): ScoreAnswer | null {
  return record(answer) && answer.type === "score" && typeof answer.score === "number" &&
    Number.isFinite(answer.score) && answer.score >= 0 && probability(answer.confidence) &&
    record(answer.probabilities) && Object.values(answer.probabilities).every(probability)
    ? answer as unknown as ScoreAnswer : null;
}

export function asChoice(answer: Answer | undefined): ChoiceAnswer | null {
  return record(answer) && answer.type === "choice" && typeof answer.choice === "string" &&
    probability(answer.confidence) && record(answer.probabilities) &&
    Object.values(answer.probabilities).every(probability) && Object.hasOwn(answer.probabilities, answer.choice)
    ? answer as unknown as ChoiceAnswer : null;
}

export function asNoul(answer: Answer | undefined): number | null {
  return record(answer) && answer.type === "noul" && probability(answer.noul) ? answer.noul : null;
}

/**
 * Shared confidence configuration. Each lens defines its own fallback; hard
 * admission budgets still apply during failure.
 */
export interface FailOpenOptions {
  /** Below this, a Choice or Score answer is not trusted. Default 0.55. */
  minConfidence?: number;
  /** Default true. */
  failOpen?: boolean;
}

export class JevusherError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "JevusherError";
  }
}
