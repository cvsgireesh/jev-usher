import { comparisonMetrics } from "./metrics.js";

const $ = (id) => document.getElementById(id);
const state = {
  status: null,
  scenario: null,
  run: null,
  startedAt: 0,
  timer: null,
  polling: false,
  csrfToken: null,
  lastResult: null,
  keyBusy: false,
};
const number = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
    : "—";
const duration = (value) =>
  Number.isFinite(value) ? `${(value / 1000).toFixed(1)} s` : "—";
const modelName = (value) =>
  typeof value === "string"
    ? ["sonnet", "opus", "haiku"]
        .find((name) => value.toLowerCase().includes(name))
        ?.replace(/^./, (letter) => letter.toUpperCase()) || value
    : "Unknown model";

async function api(path, options = {}) {
  const headers = { Accept: "application/json", ...options.headers };
  if (options.body) headers["Content-Type"] = "application/json";
  if (state.csrfToken) headers["X-Jevusher-Token"] = state.csrfToken;
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "The local server is not responding. Restart jev-usher ui, then refresh this page.",
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "The local server returned an unreadable response. Restart jev-usher ui and try again.",
    );
  }
  if (!response.ok) {
    const error = new Error(
      typeof body.error === "string"
        ? body.error
        : body.error?.message || `The request failed (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function setError(message) {
  $("global-error").textContent = message || "";
  $("global-error").hidden = !message;
}

function updateControls() {
  const busy = Boolean(state.run) || state.keyBusy;
  const ready =
    state.status?.jevConfigured &&
    state.status?.claude?.available &&
    state.status?.claude?.authenticated;
  $("run-compare").disabled = busy || !ready || !state.scenario;
  $("scenario").disabled = busy || !state.status?.scenarios?.length;
  for (const id of [
    "baseline-model",
    "api-key",
    "save-key",
    "clear-key",
    "refresh-status",
  ])
    $(id).disabled = busy;
  $("run-compare").textContent = state.run ? "Comparing…" : "Run comparison →";
  $("connection-status").textContent = state.status
    ? ready
      ? "Ready to compare"
      : "Setup needed"
    : "Connecting…";
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    state.status = status;
    state.csrfToken = status.csrfToken || null;
    $("jev-status").textContent = status.jevConfigured
      ? "JEV key configured"
      : "Add your JEV API key below.";
    $("clear-key").hidden = status.keySource !== "memory";
    const claude = status.claude || {};
    const connected = claude.available && claude.authenticated;
    $("claude-status").textContent = connected
      ? `Claude is signed in locally${claude.version ? ` · ${claude.version}` : ""}`
      : claude.message ||
        (claude.available
          ? "Run claude auth login in your terminal."
          : "Install Claude Code to compare answers.");
    if (!status.jevConfigured || !connected) $("connection-setup").open = true;
    const previous = state.scenario?.id;
    const scenarios = Array.isArray(status.scenarios) ? status.scenarios : [];
    $("scenario").replaceChildren();
    for (const scenario of scenarios) {
      const option = document.createElement("option");
      option.value = scenario.id;
      option.textContent = scenario.title;
      $("scenario").append(option);
    }
    const selected =
      scenarios.find((item) => item.id === previous) || scenarios[0];
    if (selected) {
      $("scenario").value = selected.id;
      if (state.scenario?.id !== selected.id) selectScenario(selected.id);
    } else {
      state.scenario = null;
      const option = document.createElement("option");
      option.textContent = "No scenarios available";
      $("scenario").append(option);
    }
    if (!state.run && status.run?.status === "running") {
      if (["sonnet", "opus", "haiku"].includes(status.run.baselineModel))
        $("baseline-model").value = status.run.baselineModel;
      if (scenarios.some((item) => item.id === status.run.scenarioId)) {
        $("scenario").value = status.run.scenarioId;
        selectScenario(status.run.scenarioId);
      }
      startPolling(status.run);
    }
    setError(null);
  } catch (error) {
    setError(error.message);
  } finally {
    updateControls();
  }
}

function placeholder(prefix, message, status = "Ready") {
  const hint = document.createElement("p");
  hint.className = "empty-answer";
  hint.textContent = message;
  $(`${prefix}-output`).replaceChildren(hint);
  $(`${prefix}-status`).textContent = status;
  $(`${prefix}-status`).dataset.tone = "neutral";
}

function resetResult() {
  state.lastResult = null;
  placeholder("baseline", "Claude’s answer will appear here.");
  placeholder("filtered", "The same task, using jev-usher.");
  $("baseline-model-label").textContent = modelName($("baseline-model").value);
  $("filtered-model-label").textContent = "Automatic model choice";
  for (const metric of ["tokens", "time", "quality"]) {
    $(`${metric}-change`).textContent = "—";
    $(`${metric}-values`).textContent = "Without — · With —";
    $(`${metric}-card`).dataset.tone = "neutral";
  }
  $("result-summary").textContent = "Run a comparison to see what changes.";
  $("jev-cost").textContent = "";
  $("detail-summary").textContent = "";
  $("usage-details").replaceChildren();
  $("raw-result").hidden = true;
  $("result-json").textContent = "";
  $("download-report").disabled = true;
}

function selectScenario(id) {
  state.scenario =
    state.status?.scenarios?.find((item) => item.id === id) || null;
  $("scenario-description").textContent = state.scenario?.description || "";
  $("task-prompt").textContent = state.scenario?.prompt || "";
  const source = state.scenario?.source;
  $("source-text").textContent =
    typeof source === "string"
      ? source
      : Array.isArray(source)
        ? source
            .map((item) =>
              typeof item === "string"
                ? item
                : `${item.id || ""}\n${item.text || ""}`,
            )
            .join("\n\n")
        : "";
  resetResult();
  updateControls();
}

async function startRun() {
  if (state.run || !state.scenario || $("run-compare").disabled) return;
  setError(null);
  resetResult();
  const settings = {
    scenarioId: state.scenario.id,
    mode: "compare",
    optimization: "combined",
    baselineModel: $("baseline-model").value,
  };
  state.run = { id: null, ...settings };
  state.startedAt = Date.now();
  placeholder("baseline", "Waiting for Claude…", "Waiting");
  placeholder("filtered", "Waiting for Claude…", "Waiting");
  $("run-progress").hidden = false;
  $("run-phase").textContent = "Starting comparison…";
  $("run-elapsed").textContent = "";
  $("result-summary").textContent = "Comparison in progress.";
  $("cancel-run").disabled = true;
  $("cancel-run").textContent = "Cancel";
  updateControls();
  try {
    startPolling({
      ...settings,
      ...(await api("/api/runs", {
        method: "POST",
        body: JSON.stringify(settings),
      })),
    });
  } catch (error) {
    finishError(error.message);
  }
}

function startPolling(run) {
  if (!run.id)
    return finishError(
      "No test ID was returned. Refresh the connections and try again.",
    );
  state.run = run;
  state.startedAt ||= Date.now();
  $("run-progress").hidden = false;
  $("cancel-run").disabled = false;
  updateControls();
  void pollRun();
}

async function pollRun() {
  if (!state.run || state.polling) return;
  state.polling = true;
  const id = state.run.id;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.run?.id !== id) return;
    const phase = run.phase || "The comparison is running…";
    $("run-phase").textContent = /choosing/.test(phase)
      ? "JEV is choosing a model…"
      : /baseline/.test(phase)
        ? "Running Claude without jev-usher…"
        : /running with/.test(phase)
          ? "Running Claude with jev-usher…"
          : phase;
    $("run-elapsed").textContent = duration(Date.now() - state.startedAt);
    if (run.status === "complete") {
      state.lastResult = run.result || {};
      renderResult(state.lastResult);
      finishRun();
    } else if (run.status === "cancelled") {
      finishError(
        "Comparison cancelled. Calls already sent may still use your allowance.",
      );
    } else if (run.status === "error") {
      finishError(
        typeof run.error === "string"
          ? run.error
          : "The comparison could not finish. Check your connection and account allowance.",
      );
    } else {
      state.timer = setTimeout(() => {
        void pollRun();
      }, 1000);
    }
  } catch (error) {
    finishError(error.message);
  } finally {
    state.polling = false;
  }
}

function finishRun() {
  clearTimeout(state.timer);
  state.timer = null;
  state.run = null;
  state.startedAt = 0;
  $("run-progress").hidden = true;
  updateControls();
}

function finishError(message) {
  finishRun();
  placeholder("baseline", "No completed comparison.", "Incomplete");
  placeholder("filtered", "No completed comparison.", "Incomplete");
  $("result-summary").textContent = "No complete result to compare.";
  setError(message);
}

function renderAnswer(prefix, answer, passed, total) {
  const parent = $(`${prefix}-output`);
  const output = typeof answer?.output === "string" ? answer.output : "";
  parent.replaceChildren();
  let fields;
  try {
    fields = JSON.parse(
      output
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    /* Plain text answers are displayed as received. */
  }
  if (
    total !== null &&
    passed === total &&
    fields &&
    typeof fields === "object" &&
    !Array.isArray(fields) &&
    Object.keys(fields).length &&
    Object.values(fields).every(
      (value) =>
        value === null ||
        ["string", "number", "boolean"].includes(typeof value),
    )
  ) {
    const list = document.createElement("dl");
    list.className = "answer-fields";
    for (const [key, value] of Object.entries(fields)) {
      const row = document.createElement("div");
      const label = document.createElement("dt");
      const content = document.createElement("dd");
      label.textContent = key
        .replace(/_/g, " ")
        .replace(/^./, (letter) => letter.toUpperCase());
      content.textContent =
        typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
      row.append(label, content);
      list.append(row);
    }
    parent.append(list);
  } else {
    const text = document.createElement("pre");
    text.textContent = output || "No answer recorded.";
    parent.append(text);
  }
  const models = Array.isArray(answer?.models)
    ? answer.models.filter((value) => typeof value === "string")
    : [];
  $(`${prefix}-model-label`).textContent = models.length
    ? [...new Set(models.map(modelName))].join(" · ")
    : "Model not recorded";
  $(`${prefix}-status`).textContent =
    total === null ? "Not checked" : `${passed}/${total} checks passed`;
  $(`${prefix}-status`).dataset.tone =
    total === null ? "neutral" : passed === total ? "benefit" : "worse";
}

function renderDifference(id, metric, unit) {
  const { before, after, saved, percent, tone } = metric;
  const format = unit === "tokens" ? number : duration;
  $(`${id}-values`).textContent =
    `Without ${format(before)} · With ${format(after)}`;
  $(`${id}-card`).dataset.tone = tone;
  let change = "Not measured";
  if (saved === 0) change = "No change";
  else if (saved !== null) {
    const magnitude =
      percent === null
        ? format(Math.abs(saved))
        : Math.abs(percent) < 0.1
          ? "<0.1%"
          : `${Math.abs(percent).toFixed(1).replace(/\.0$/, "")}%`;
    change = `${magnitude} ${unit === "tokens" ? (saved > 0 ? "fewer" : "more") : saved > 0 ? "faster" : "slower"}`;
  }
  $(`${id}-change`).textContent = change;
}

function renderResult(result) {
  const metrics = comparisonMetrics(result);
  const quality = metrics.quality;
  renderAnswer(
    "baseline",
    result.baseline,
    quality.baselinePassed,
    quality.baselineTotal,
  );
  renderAnswer(
    "filtered",
    result.filtered,
    quality.filteredPassed,
    quality.filteredTotal,
  );
  renderDifference("tokens", metrics.tokens, "tokens");
  renderDifference("time", metrics.time, "time");
  const completeChecks =
    quality.baselineTotal !== null && quality.filteredTotal !== null;
  const answersPassed =
    completeChecks &&
    quality.baselinePassed === quality.baselineTotal &&
    quality.filteredPassed === quality.filteredTotal;
  $("quality-change").textContent = !completeChecks
    ? "Not verified"
    : answersPassed
      ? "Both passed"
      : "Check failed";
  $("quality-card").dataset.tone =
    quality.passed === true
      ? "benefit"
      : completeChecks && !answersPassed
        ? "worse"
        : "neutral";
  const checks = (passed, total) =>
    total === null ? "—" : `${passed}/${total}`;
  $("quality-values").textContent =
    `Without ${checks(quality.baselinePassed, quality.baselineTotal)} · With ${checks(quality.filteredPassed, quality.filteredTotal)}`;
  $("result-summary").textContent =
    quality.passed === true
      ? "Both answers passed the checks."
      : completeChecks && !answersPassed
        ? "Answer checks failed. Inspect the answers before judging savings."
        : answersPassed
          ? "Answers passed; the comparison setup could not be verified."
          : "This comparison could not be verified.";
  $("jev-cost").textContent =
    metrics.jevCost === null
      ? "JEV cost estimate unavailable."
      : `Estimated JEV cost for this comparison: $${metrics.jevCost.toFixed(6)}.`;
  $("detail-summary").textContent = result.verdict?.summary || "";
  const details = $("usage-details");
  details.replaceChildren();
  const addDetail = (label, value) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    details.append(row);
  };
  for (const [variant, label] of [
    ["baseline", "Without"],
    ["filtered", "With"],
  ]) {
    const answer = result[variant];
    addDetail(`${label} · model`, answer?.models?.join(", ") || "Not recorded");
    for (const [key, title] of [
      ["inputTokens", "input"],
      ["outputTokens", "output"],
      ["cacheReadTokens", "cached input"],
      ["cacheWriteTokens", "cache creation"],
    ])
      addDetail(`${label} · ${title}`, number(answer?.usage?.[key]));
  }
  addDetail("Initial source tokens", number(result.admission?.offeredTokens));
  addDetail(
    "Initially admitted tokens",
    number(result.admission?.admittedTokens),
  );
  addDetail(
    "Recovered source tokens",
    number(result.admission?.recoveredTokens),
  );
  if (result.routing)
    addDetail(
      "Model selection",
      result.routing.trusted
        ? "JEV’s confident choice used"
        : "Baseline model retained",
    );
  addDetail(
    "Run order",
    Array.isArray(result.order)
      ? result.order
          .map((variant) => (variant === "baseline" ? "Without" : "With"))
          .join(" → ")
      : "Not recorded",
  );
  $("result-json").textContent = JSON.stringify(result, null, 2);
  $("raw-result").hidden = false;
  $("download-report").disabled = false;
}

$("refresh-status").addEventListener("click", () => {
  void refreshStatus();
});
for (const id of ["scenario", "baseline-model"])
  $(id).addEventListener("change", () => selectScenario($("scenario").value));
$("run-compare").addEventListener("click", () => {
  void startRun();
});
$("cancel-run").addEventListener("click", async () => {
  if (!state.run?.id) return;
  const id = state.run.id;
  $("cancel-run").disabled = true;
  $("cancel-run").textContent = "Cancelling…";
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    if (state.run?.id !== id) return;
    if (error.status === 409) {
      void pollRun();
      return;
    }
    setError(error.message);
    $("cancel-run").disabled = false;
    $("cancel-run").textContent = "Cancel";
  }
});
$("download-report").addEventListener("click", () => {
  if (!state.lastResult) return;
  const report = {
    exportedAt: new Date().toISOString(),
    scenario: state.scenario?.id || null,
    result: state.lastResult,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `jev-usher-${state.scenario?.id || "test"}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("clear-key").addEventListener("click", async () => {
  if (state.run || state.keyBusy) return;
  state.keyBusy = true;
  updateControls();
  try {
    await api("/api/key", { method: "DELETE" });
    $("api-key").value = "";
    $("key-message").textContent =
      "Session key removed. An environment key, if configured, remains available.";
    await refreshStatus();
  } catch (error) {
    $("key-message").textContent = error.message;
  } finally {
    state.keyBusy = false;
    updateControls();
  }
});
$("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.run || state.keyBusy) return;
  const key = $("api-key").value.trim();
  if (!key) return;
  state.keyBusy = true;
  updateControls();
  $("key-message").textContent = "Setting your session key…";
  try {
    await api("/api/key", { method: "POST", body: JSON.stringify({ key }) });
    $("key-message").textContent =
      "Key configured. A comparison will verify it with JEV.";
    await refreshStatus();
    if (state.status?.claude?.authenticated) $("connection-setup").open = false;
  } catch (error) {
    $("key-message").textContent = error.message;
  } finally {
    $("api-key").value = "";
    state.keyBusy = false;
    updateControls();
  }
});
void refreshStatus();
