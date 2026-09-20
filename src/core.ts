import type { Provider } from "./client.js";
import type {
  Answer,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
  SystemOneRequest,
  SystemOneResponse,
  Usage,
} from "./types.js";

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

/** Run prepared requests in parallel. */
export function runBatches(provider: Provider, requests: SystemOneRequest[]): Promise<SystemOneResponse[]> {
  return Promise.all(requests.map((request) => provider.evaluate(request)));
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
  return answer?.type === "score" ? (answer as ScoreAnswer) : null;
}

export function asChoice(answer: Answer | undefined): ChoiceAnswer | null {
  return answer?.type === "choice" ? (answer as ChoiceAnswer) : null;
}

export function asNoul(answer: Answer | undefined): number | null {
  return answer?.type === "noul" ? (answer as NoulAnswer).noul : null;
}

/**
 * Every lens shares this posture: when Jev is unsure or unreachable, behave as
 * though no lens were installed. A wrong cheap decision costs an expensive turn.
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
