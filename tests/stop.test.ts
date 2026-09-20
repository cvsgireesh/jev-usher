import { describe, expect, it } from "vitest";
import { StopGate } from "../src/index.js";
import { noul, stub } from "./helpers.js";

function gate(goalMet: number, looping: number, needsUser: number) {
  return stub(() => ({ goal_met: noul(goalMet), looping: noul(looping), needs_user: noul(needsUser) }));
}

describe("StopGate.check", () => {
  it("stops when the goal is met", async () => {
    const result = await new StopGate({ provider: gate(0.95, 0.1, 0.1) }).check({ goal: "g", work: "done" });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("goal-met");
  });

  it("stops when the next action repeats a failed attempt", async () => {
    const result = await new StopGate({ provider: gate(0.2, 0.9, 0.1) }).check({
      goal: "g",
      work: "tried twice",
      nextAction: "try the same thing",
    });
    expect(result.reason).toBe("looping");
  });

  it("stops when only the user can unblock it", async () => {
    const result = await new StopGate({ provider: gate(0.2, 0.1, 0.95) }).check({ goal: "g", work: "w" });
    expect(result.reason).toBe("needs-user");
  });

  it("continues when nothing crosses a threshold", async () => {
    const result = await new StopGate({ provider: gate(0.4, 0.3, 0.2) }).check({ goal: "g", work: "w" });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe("continue");
  });

  it("prefers goal-met over looping when both fire", async () => {
    const result = await new StopGate({ provider: gate(0.95, 0.95, 0.1) }).check({ goal: "g", work: "w" });
    expect(result.reason).toBe("goal-met");
  });

  it("never halts the agent because the gate was unreachable", async () => {
    const provider = stub(() => ({}), { failWith: new Error("503") });
    const result = await new StopGate({ provider }).check({ goal: "g", work: "w" });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe("unavailable");
  });
});
