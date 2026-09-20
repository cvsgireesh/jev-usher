import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jevusher, type Answer, type Capability, type Candidate } from "../src/index.js";
import { onPostToolUse, onStop, onUserPromptSubmit } from "../src/hook.js";
import { choice, noul, score, stub } from "./helpers.js";

let home: string;
const saved = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jevusher-"));
  process.env.JEVUSHER_SCREEN = "1";
  process.env.JEVUSHER_HOME = home;
  process.env.JEVUSHER_LEDGER = join(home, "ledger.jsonl");
});

afterEach(() => {
  process.env = { ...saved };
});

const pipelineStub = stub((request): Record<string, Answer> => {
  const questions = request.questions;
  if ("tier" in questions) return { tier: choice("mechanical", 0.9), needs_files: noul(0.5), needs_tools: noul(0.5) };
  if ("pick" in questions) return { pick: choice("git", 0.9, { git: 0.9 }) };
  const state = request.state as { catalog?: Capability[]; candidates?: Candidate[] };
  const answers: Record<string, Answer> = {};
  state.catalog?.forEach((entry, i) => (answers[`r${i}`] = score(entry.id === "git" ? 2 : 0)));
  state.candidates?.forEach((c, i) => (answers[`c${i}`] = score(c.id === "m1" ? 2 : 0)));
  if ("need" in questions) answers.need = noul(0.9);
  return answers;
});

describe("onUserPromptSubmit", () => {
  it("returns nothing when there is no prompt", async () => {
    expect(await onUserPromptSubmit({ prompt: "  " }, new Jevusher({ provider: pipelineStub }))).toEqual({});
  });

  it("returns nothing when memory and catalog are both empty", async () => {
    const output = await onUserPromptSubmit({ prompt: "hello" }, new Jevusher({ provider: pipelineStub }));
    expect(output).toEqual({});
  });

  it("injects admitted memory and the selected capability", async () => {
    await writeFile(
      join(home, "memory.jsonl"),
      [
        JSON.stringify({ id: "m1", text: "the cookie was changed to SameSite=Strict" }),
        JSON.stringify({ id: "m2", text: "standup is at 9:15" }),
      ].join("\n"),
    );
    await writeFile(join(home, "catalog.jsonl"), JSON.stringify({ id: "git", name: "git", summary: "version control" }));

    const output = await onUserPromptSubmit({ prompt: "why does login loop" }, new Jevusher({ provider: pipelineStub }));
    const context = output.hookSpecificOutput?.additionalContext ?? "";
    expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(context).toContain("SameSite=Strict");
    expect(context).not.toContain("standup");
    expect(context).toContain("git");
  });

  it("never blocks a prompt", async () => {
    await writeFile(join(home, "memory.jsonl"), JSON.stringify({ id: "m1", text: "x" }));
    const output = await onUserPromptSubmit({ prompt: "x" }, new Jevusher({ provider: pipelineStub }));
    expect(output.decision).toBeUndefined();
  });
});

const long = "lorem ipsum ".repeat(1200);

describe("onPostToolUse", () => {
  const screenStub = (injection: number) =>
    stub((request): Record<string, Answer> => {
      const state = request.state as { items: Candidate[] };
      const answers: Record<string, Answer> = {};
      state.items.forEach((_, i) => {
        answers[`i${i}`] = noul(injection);
        answers[`j${i}`] = noul(injection);
        answers[`h${i}`] = score(injection > 0.5 ? 2 : 0);
      });
      return answers;
    });

  it("warns when fetched content is issuing instructions", async () => {
    const output = await onPostToolUse(
      { tool_name: "WebFetch", tool_response: { content: long } },
      new Jevusher({ provider: screenStub(0.95) }),
    );
    expect(output.hookSpecificOutput?.additionalContext).toContain("HIGH");
    expect(output.hookSpecificOutput?.additionalContext).toContain("strictly as data");
  });

  it("stays silent on clean content", async () => {
    const output = await onPostToolUse(
      { tool_name: "WebFetch", tool_response: { content: long } },
      new Jevusher({ provider: screenStub(0.01) }),
    );
    expect(output).toEqual({});
  });

  it("ignores local tools but screens short external outputs", async () => {
    const provider = screenStub(0.99);
    const jevusher = new Jevusher({ provider });
    expect(await onPostToolUse({ tool_name: "Read", tool_response: { content: long } }, jevusher)).toEqual({});
    expect((await onPostToolUse({ tool_name: "WebFetch", tool_response: { content: "tiny" } }, jevusher)).hookSpecificOutput?.additionalContext).toContain("HIGH");
    expect(provider.requests).toHaveLength(1);
  });
});

describe("onStop", () => {
  const stopStub = (goalMet: number, needsUser = 0.05) =>
    stub((): Record<string, Answer> => ({
      goal_met: noul(goalMet),
      looping: noul(0.1),
      needs_user: noul(needsUser),
    }));

  it("blocks stopping when the goal is clearly unmet", async () => {
    process.env.JEVUSHER_GOAL = "ship the feature";
    const output = await onStop(
      { last_assistant_message: "I started looking at it" },
      new Jevusher({ provider: stopStub(0.05) }),
    );
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("ship the feature");
  });

  it("lets the turn end when the goal looks met", async () => {
    process.env.JEVUSHER_GOAL = "g";
    const output = await onStop({ last_assistant_message: "done" }, new Jevusher({ provider: stopStub(0.9) }));
    expect(output).toEqual({});
  });

  it("does not block when the user is the blocker", async () => {
    process.env.JEVUSHER_GOAL = "g";
    const output = await onStop(
      { last_assistant_message: "need your decision" },
      new Jevusher({ provider: stopStub(0.05, 0.9) }),
    );
    expect(output).toEqual({});
  });

  it("stands down once a stop hook is already blocking", async () => {
    process.env.JEVUSHER_GOAL = "g";
    const output = await onStop(
      { stop_hook_active: true, last_assistant_message: "x" },
      new Jevusher({ provider: stopStub(0.01) }),
    );
    expect(output).toEqual({});
  });

  it("does nothing without a configured goal", async () => {
    delete process.env.JEVUSHER_GOAL;
    const output = await onStop({ last_assistant_message: "x" }, new Jevusher({ provider: stopStub(0.01) }));
    expect(output).toEqual({});
  });
});
