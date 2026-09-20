import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { asNoul, asScore, runBatches } from "./core.js";
import { requiredText, candidates as validateCandidates, integer, nonNegative, threshold as validateThreshold } from "./validation.js";
import { candidateTokens, boundedChunks, totalTokens } from "./budget.js";
import type {
  AdmitReason,
  AdmitResult,
  Candidate,
  ScoreAnswer,
  Question,
  SystemOneResponse,
  Usage,
  Verdict,
} from "./types.js";

/** Ordered lowest-relevance first. Index position is the score scale. */
export const DEFAULT_LEVELS = [
  "Irrelevant to the goal. Including it would only waste space.",
  "Loosely related background. The goal can be met without it.",
  "Directly needed. The goal cannot be met correctly without this material.",
];

export interface AdmitOptions {
  /** What the expensive model is actually trying to do. Relevance is judged against this. */
  goal: string;
  candidates: Candidate[];
  /** Ceiling on admitted tokens. Default 4000. */
  budget?: number;
  /**
   * Minimum score to admit, on the levels scale. Default 1.5, i.e. closer to
   * "directly needed" than to "background" on the three default levels.
   */
  threshold?: number;
  /** Below this confidence the score is not trusted. Default 0.55. */
  minConfidence?: number;
  /**
   * What to do with material Jev is unsure about, and with provider failures.
   * Default true: let it through. Dropping context you needed is far more
   * expensive than admitting context you did not.
   */
  failOpen?: boolean;
  /** Also ask whether the goal needs any of this material at all. Default true. */
  checkNeed?: boolean;
  /** Turn everything away when the need probability falls below this. Default 0.15. */
  needThreshold?: number;
  /** Override the relevance rubric. At least two levels, lowest first. */
  levels?: string[];
  /** Candidates per request. Default 64. Chunks run in parallel. */
  batchSize?: number;
}

export interface UsherConfig extends JevClientConfig {
  /** Supply your own provider (or a stub in tests) instead of a JevClient. */
  provider?: Provider;
}

interface Scored {
  candidate: Candidate;
  score: number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  tokens: number;
}

/**
 * Admission control for a context window.
 *
 * Jev reads every candidate cheaply and says which ones deserve a place;
 * your code assembles the result. The expensive model only ever sees what got in.
 */
export class Usher {
  private readonly provider: Provider;

  constructor(config: UsherConfig = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async admit(options: AdmitOptions): Promise<AdmitResult> {
    const {
      goal,
      candidates,
      budget = 4000,
      threshold = 1.5,
      minConfidence = 0.55,
      failOpen = true,
      checkNeed = true,
      needThreshold = 0.15,
      levels = DEFAULT_LEVELS,
      batchSize = 64,
    } = options;

    requiredText(goal, "goal");
    validateCandidates(candidates);
    integer(batchSize, "batchSize", 1);
    nonNegative(budget, "budget");
    nonNegative(threshold, "threshold");
    validateThreshold(minConfidence, "minConfidence");
    validateThreshold(needThreshold, "needThreshold");
    if (levels.length < 2) throw new RangeError("levels needs at least two entries");

    const tokensOffered = totalTokens(candidates);
    if (candidates.length === 0) {
      return {
        admitted: [],
        verdicts: [],
        need: null,
        jevUsage: { input_tokens: 0, output_tokens: 0 },
        tokensOffered: 0,
        tokensAdmitted: 0,
        requests: 0,
        model: null,
      };
    }

    const batches = boundedChunks(candidates, batchSize, ({ id, text }) => ({ id, text }));
    let responses: SystemOneResponse[];
    try {
      responses = await runBatches(this.provider,
        batches.map((batch) => ({
            model: this.provider.model ?? DEFAULT_MODEL,
            state: { goal, candidates: batch.map(({ id, text }) => ({ id, text })) },
            questions: buildQuestions(batch, levels, checkNeed),
          })),
      );
    } catch (error) {
      if (!failOpen) throw error;
      return admitEverything(candidates, budget, tokensOffered);
    }

    const usage = responses.reduce<Usage>(
      (sum, response) => ({
        input_tokens: sum.input_tokens + (response.usage?.input_tokens ?? 0),
        output_tokens: sum.output_tokens + (response.usage?.output_tokens ?? 0),
      }),
      { input_tokens: 0, output_tokens: 0 },
    );

    // A batch only sees its own candidates. Never let the first batch veto later ones.
    const needs = checkNeed ? responses.map(r => asNoul(r.answers?.[NEED_KEY])) : [];
    const need = needs.length && needs.every(n => n !== null) ? Math.max(...needs as number[]) : null;

    const scored: Scored[] = [];
    batches.forEach((batch, batchIndex) => {
      const answers = responses[batchIndex]?.answers ?? {};
      batch.forEach((candidate, position) => {
        const answer = asScore(answers[questionKey(position)]);
        const isScore = answer !== null && answer.score <= levels.length - 1;
        scored.push({
          candidate,
          score: isScore ? (answer as ScoreAnswer).score : null,
          confidence: isScore ? (answer as ScoreAnswer).confidence : null,
          probabilities: isScore ? (answer as ScoreAnswer).probabilities : null,
          tokens: candidateTokens(candidate),
        });
      });
    });

    scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

    // The goal is self-contained: turn everyone away, but only when Jev is clear about it.
    if (need !== null && need < needThreshold) {
      return {
        admitted: [],
        verdicts: scored.map((entry) => verdictOf(entry, false, "goal-needs-no-context")),
        need,
        jevUsage: usage,
        tokensOffered,
        tokensAdmitted: 0,
        requests: responses.length,
        model: responses[0]?.model ?? null,
      };
    }

    const verdicts: Verdict[] = [];
    const admitted: Candidate[] = [];
    let spent = 0;

    for (const entry of scored) {
      const trusted = entry.score !== null && (entry.confidence ?? 0) >= minConfidence;
      const eligible = trusted ? entry.score! >= threshold : failOpen;

      if (!eligible) {
        verdicts.push(verdictOf(entry, false, trusted ? "below-threshold" : "low-confidence-turned-away"));
        continue;
      }
      if (spent + entry.tokens > budget) {
        verdicts.push(verdictOf(entry, false, "over-budget"));
        continue;
      }
      spent += entry.tokens;
      admitted.push(entry.candidate);
      verdicts.push(verdictOf(entry, true, trusted ? "admitted" : "low-confidence-admitted"));
    }

    return {
      admitted,
      verdicts,
      need,
      jevUsage: usage,
      tokensOffered,
      tokensAdmitted: spent,
      requests: responses.length,
      model: responses[0]?.model ?? null,
    };
  }
}

const NEED_KEY = "need";

function questionKey(position: number): string {
  return `c${position}`;
}

function buildQuestions(batch: Candidate[], levels: string[], withNeed: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {};
  batch.forEach((candidate, position) => {
    questions[questionKey(position)] = {
      type: "score",
      instructions: {
        task: "Rate how much the candidate with this id is needed to accomplish the goal in the state.",
        candidate_id: candidate.id,
      },
      criteria: levels,
    };
  });
  if (withNeed) {
    questions[NEED_KEY] = {
      type: "noul",
      instructions:
        "Considering only the goal in the state, does accomplishing it require any of the supplied candidate material?",
      criteria: {
        true: "The goal depends on specific material that must be supplied.",
        false: "The goal is self-contained and can be answered without any of the candidates.",
      },
    };
  }
  return questions;
}

function verdictOf(entry: Scored, admitted: boolean, reason: AdmitReason): Verdict {
  return {
    id: entry.candidate.id,
    score: entry.score,
    confidence: entry.confidence,
    probabilities: entry.probabilities,
    admitted,
    reason,
    tokens: entry.tokens,
  };
}

/** Provider failure: retain original input order subject to the hard admission budget. */
function admitEverything(candidates: Candidate[], budget: number, tokensOffered: number): AdmitResult {
  const admitted: Candidate[] = [];
  const verdicts: Verdict[] = [];
  let spent = 0;
  for (const candidate of candidates) {
    const tokens = candidateTokens(candidate);
    const fits = spent + tokens <= budget;
    if (fits) {
      spent += tokens;
      admitted.push(candidate);
    }
    verdicts.push({
      id: candidate.id,
      score: null,
      confidence: null,
      probabilities: null,
      admitted: fits,
      reason: fits ? "provider-error-admitted" : "over-budget",
      tokens,
    });
  }
  return {
    admitted,
    verdicts,
    need: null,
    jevUsage: { input_tokens: 0, output_tokens: 0 },
    tokensOffered,
    tokensAdmitted: spent,
    requests: 0,
    model: null,
  };
}
