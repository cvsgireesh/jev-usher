/**
 * One lens, measured on real material.
 *
 * Every number here comes from a live call: Claude's own usage and cost fields,
 * or the Jev API's. Nothing is modelled, estimated, or scaled from a sample.
 */
export interface LensResult {
  lens: string;
  title: string;
  /** What the material actually is and where it came from, in one line. */
  source: string;
  question: string;

  without: Side;
  with: Side;

  /** What Jev cost to make the decision. */
  doorman: { tokens: number; costUsd: number; ms: number; note: string };

  /** Tokens every call pays before any material. Identical on both sides. */
  floorTokens: number;

  /** Set when the saving is not a token saving. */
  caveat?: string;
}

export interface Side {
  label: string;
  /** Tokens of material, with the common floor removed. */
  materialTokens: number;
  totalTokens: number;
  costUsd: number;
  ms: number;
  model: string;
  answer: string;
  /** What this side was handed, for the visual. */
  items?: { id: string; label: string; admitted: boolean; blocked?: boolean }[];
}

export function side(
  label: string,
  run: { inputTokens: number; costUsd: number; ms: number; model: string; answer: string },
  floorTokens: number,
  items?: Side["items"],
): Side {
  return {
    label,
    materialTokens: Math.max(0, run.inputTokens - floorTokens),
    totalTokens: run.inputTokens,
    costUsd: run.costUsd,
    ms: run.ms,
    model: run.model,
    answer: run.answer,
    ...(items && { items }),
  };
}
