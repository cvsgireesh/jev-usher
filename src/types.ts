/** Shapes for the TypeSafe System One HTTP API (POST /v1/systemone). */

export type StateValue = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: StateValue;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: StateValue;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: StateValue;
  /** Ordered level descriptions, lowest first. At least two. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level index; can land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneRequest {
  state: StateValue;
  model: string;
  questions: Record<string, Question>;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

/** A single piece of content competing for a place in the context window. */
export interface Candidate {
  id: string;
  text: string;
  /** Token cost if admitted. Estimated from `text` when omitted. */
  tokens?: number;
  /** Passed through untouched; useful for carrying source metadata. */
  meta?: Record<string, unknown>;
}

export type AdmitReason =
  | "admitted"
  | "over-budget"
  | "below-threshold"
  | "low-confidence-admitted"
  | "low-confidence-turned-away"
  | "goal-needs-no-context"
  | "provider-error-admitted";

export interface Verdict {
  id: string;
  /** Position on the levels scale, 0 = least relevant. null if never scored. */
  score: number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  admitted: boolean;
  reason: AdmitReason;
  tokens: number;
}

export interface AdmitResult {
  /** Candidates that earned a place, ordered by score descending. */
  admitted: Candidate[];
  /** Every candidate's verdict, ordered by score descending. */
  verdicts: Verdict[];
  /**
   * Probability the goal needs any of this material at all, from the need check.
   * null when `checkNeed` was false.
   */
  need: number | null;
  /** Tokens Jev read to make these decisions. */
  jevUsage: Usage;
  /** Tokens the candidates would have cost if all were admitted. */
  tokensOffered: number;
  /** Tokens actually admitted. */
  tokensAdmitted: number;
  /** Requests made against the provider. */
  requests: number;
  model: string | null;
}
