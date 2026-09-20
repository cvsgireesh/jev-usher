import { DEFAULT_MODEL, JevClient, type JevClientConfig, type Provider } from "./client.js";
import { requiredText, threshold } from "./validation.js";
import { asNoul, runBatches, sumUsage, ZERO_USAGE } from "./core.js";
import type { StateValue, Usage } from "./types.js";

export interface StopOptions {
  /** What the agent set out to do. */
  goal: string;
  /** What it has done so far: recent actions, outputs, test results. */
  work: StateValue;
  /** The action it is about to take. Sharpens the repetition check. */
  nextAction?: string;
  /** Probability above which the goal counts as met. Default 0.8. */
  metThreshold?: number;
  /** Probability above which the agent counts as looping. Default 0.75. */
  loopThreshold?: number;
}

export type StopReason = "goal-met" | "looping" | "needs-user" | "continue" | "unavailable";

export interface StopResult {
  shouldStop: boolean;
  reason: StopReason;
  /** Probability the stated goal has been accomplished. */
  goalMet: number | null;
  /** Probability the next action repeats something already tried and failed. */
  looping: number | null;
  /** Probability progress is blocked on a decision only the user can make. */
  needsUser: number | null;
  usage: Usage;
}

/**
 * J6 — the stop gate.
 *
 * The cheapest token is the turn you never take. An agent that notices it is
 * finished, or that it is retrying a failed approach, saves an entire expensive
 * turn — which is worth more than every other lens here combined.
 */
export class StopGate {
  private readonly provider: Provider;

  constructor(config: JevClientConfig & { provider?: Provider } = {}) {
    this.provider = config.provider ?? new JevClient(config);
  }

  async check(options: StopOptions): Promise<StopResult> {
    const { goal, work, nextAction, metThreshold = 0.8, loopThreshold = 0.75 } = options;

    requiredText(goal, "goal");
    threshold(metThreshold, "metThreshold");
    threshold(loopThreshold, "loopThreshold");
    let responses;
    try {
      responses = await runBatches(this.provider, [
        {
          model: this.provider.model ?? DEFAULT_MODEL,
          state: nextAction === undefined ? { goal, work } : { goal, work, next_action: nextAction },
          questions: {
            goal_met: {
              type: "noul",
              instructions: "Has the stated goal already been accomplished by the work shown?",
              criteria: {
                true: "Everything the goal asked for is done and verified.",
                false: "Part of the goal is still outstanding, unverified, or failing.",
              },
            },
            looping: {
              type: "noul",
              instructions:
                "Does the next action repeat an approach already attempted in the work shown, without anything having changed that would make it succeed this time?",
              criteria: {
                true: "The same approach is being tried again with no new information.",
                false: "This is a new approach, or something relevant has changed.",
              },
            },
            needs_user: {
              type: "noul",
              instructions: "Is further progress blocked on a decision or information only the user can supply?",
              criteria: {
                true: "A choice belongs to the user, or required access or input is missing.",
                false: "The agent has everything it needs to keep going.",
              },
            },
          },
        },
      ]);
    } catch {
      // Never halt an agent because the gate was unreachable.
      return { shouldStop: false, reason: "unavailable", goalMet: null, looping: null, needsUser: null, usage: { ...ZERO_USAGE } };
    }

    const answers = responses[0]?.answers ?? {};
    const goalMet = asNoul(answers.goal_met);
    const looping = asNoul(answers.looping);
    const needsUser = asNoul(answers.needs_user);
    const usage = sumUsage(responses);

    if (goalMet === null || looping === null || needsUser === null) {
      return { shouldStop: false, reason: "unavailable", goalMet, looping, needsUser, usage };
    }
    if (goalMet !== null && goalMet >= metThreshold) {
      return { shouldStop: true, reason: "goal-met", goalMet, looping, needsUser, usage };
    }
    if (needsUser !== null && needsUser >= metThreshold) {
      return { shouldStop: true, reason: "needs-user", goalMet, looping, needsUser, usage };
    }
    if (looping !== null && looping >= loopThreshold) {
      return { shouldStop: true, reason: "looping", goalMet, looping, needsUser, usage };
    }
    return { shouldStop: false, reason: "continue", goalMet, looping, needsUser, usage };
  }
}
