import type { Answer, Provider, SystemOneRequest, SystemOneResponse } from "../src/index.js";

export type AnswerFactory = (request: SystemOneRequest) => Record<string, Answer>;

export interface StubProvider extends Provider {
  requests: SystemOneRequest[];
}

/** A provider whose answers you write by hand, so lens logic can be asserted exactly. */
export function stub(factory: AnswerFactory, options: { failWith?: Error } = {}): StubProvider {
  const requests: SystemOneRequest[] = [];
  return {
    model: "stub",
    requests,
    async evaluate(request) {
      if (options.failWith) throw options.failWith;
      requests.push(request);
      return {
        model: "stub",
        answers: factory(request),
        usage: { input_tokens: 100, output_tokens: 0 },
      } satisfies SystemOneResponse;
    },
  };
}

export function score(value: number, confidence = 0.9): Answer {
  return {
    type: "score",
    score: value,
    confidence,
    legend: { "0": "low", "1": "mid", "2": "high" },
    probabilities: { "0": 0, "1": 0, "2": 1 },
  };
}

export function choice(picked: string, confidence = 0.9, probabilities?: Record<string, number>): Answer {
  return {
    type: "choice",
    choice: picked,
    confidence,
    probabilities: probabilities ?? { [picked]: confidence },
  };
}

export function noul(value: number): Answer {
  return { type: "noul", noul: value };
}
