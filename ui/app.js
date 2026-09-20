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
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)
    : "—";
const duration = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(1)} s`
    : "—";
const money = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(value < 0.01 ? 6 : 4)}`
    : "—";
const modelName = (value) =>
  typeof value === "string" && value
    ? { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku" }[value] || value
    : "Unavailable";

function testSettings() {
  return {
    baselineModel: $("baseline-model").value,
    optimization: $("optimization").value,
  };
}

function applyTestSettings(settings) {
  if (["sonnet", "opus", "haiku"].includes(settings.baselineModel))
    $("baseline-model").value = settings.baselineModel;
  if (["combined", "context", "routing"].includes(settings.optimization))
    $("optimization").value = settings.optimization;
  updateOptimizationHint();
}

function updateOptimizationHint() {
  $("optimization-hint").textContent = {
    combined:
      "Compare a fixed Claude model against JEV's model choice and context selection.",
    context:
      "Use the same Claude model for both runs. JEV selects the optimized run's context.",
    routing:
      "Give both runs the full source. JEV chooses the optimized run's Claude model.",
  }[$("optimization").value];
}

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
      "The local server is not responding. Make sure Jevusher is still running, then refresh the connection.",
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "The local server returned an unreadable response. Restart Jevusher and try again.",
    );
  }
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : body.error?.message || `The request failed (${response.status}).`,
    );
  return body;
}

function setError(message) {
  $("global-error").textContent = message || "";
  $("global-error").hidden = !message;
}

function updateControls() {
  const busy = Boolean(state.run) || state.keyBusy;
  const ready = Boolean(state.status?.jevConfigured && state.scenario);
  $("run-preview").disabled = busy || !ready;
  $("run-compare").disabled =
    busy ||
    !ready ||
    !state.status?.claude?.available ||
    !state.status?.claude?.authenticated;
  $("scenario").disabled = busy || !state.status?.scenarios?.length;
  $("baseline-model").disabled = busy;
  $("optimization").disabled = busy;
  $("save-key").disabled = busy;
  $("clear-key").disabled = busy;
  $("api-key").disabled = Boolean(state.run);
  $("refresh-status").disabled = busy;
  $("run-preview").textContent =
    state.run?.mode === "preview" ? "Previewing…" : "Preview with JEV";
  $("run-compare").replaceChildren(
    document.createTextNode(
      state.run?.mode === "compare" ? "Comparing…" : "Compare with Claude",
    ),
  );
  if (state.run?.mode !== "compare") {
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    $("run-compare").append(arrow);
  }
}

async function refreshStatus(initial = false) {
  try {
    const status = await api("/api/status");
    state.status = status;
    state.csrfToken = status.csrfToken || null;
    $("jev-dot").className =
      `status-dot ${status.jevConfigured ? "is-ready" : "is-missing"}`;
    $("jev-status").textContent = status.jevConfigured
      ? `${status.model || "JEV"} · key configured`
      : "Add a key to run a test";
    $("key-toggle").textContent = status.jevConfigured
      ? "Change key"
      : "Configure key";
    $("clear-key").hidden = status.keySource !== "memory";
    const claude = status.claude || {};
    const connected = claude.available && claude.authenticated;
    $("claude-dot").className =
      `status-dot ${connected ? "is-ready" : "is-missing"}`;
    $("claude-status").textContent = connected
      ? `Signed in locally${claude.version ? ` · ${claude.version}` : ""}`
      : claude.message ||
        (claude.available
          ? "Run claude auth login in your terminal"
          : "Install Claude Code to compare answers");
    const previous = state.scenario?.id;
    const scenarios = Array.isArray(status.scenarios) ? status.scenarios : [];
    $("scenario").replaceChildren();
    for (const scenario of scenarios) {
      const option = document.createElement("option");
      option.value = scenario.id;
      option.textContent = scenario.title;
      $("scenario").append(option);
    }
    if (scenarios.length) {
      const selected =
        scenarios.find((item) => item.id === previous) || scenarios[0];
      $("scenario").value = selected.id;
      if (!state.scenario || state.scenario.id !== selected.id)
        selectScenario(selected.id);
    } else {
      const option = document.createElement("option");
      option.textContent = "No scenarios available";
      $("scenario").append(option);
    }
    if (initial && !status.jevConfigured) toggleKeyPanel(true);
    if (!state.run && status.run?.status === "running") {
      if (
        status.run.scenarioId &&
        scenarios.some((item) => item.id === status.run.scenarioId)
      ) {
        $("scenario").value = status.run.scenarioId;
        selectScenario(status.run.scenarioId);
      }
      applyTestSettings(status.run);
      startPolling(status.run);
    }
    setError(null);
  } catch (error) {
    setError(error.message);
    if (!state.status) {
      $("jev-status").textContent = "Local server unavailable";
      $("claude-status").textContent = "Local server unavailable";
    }
  } finally {
    updateControls();
  }
}

function toggleKeyPanel(open) {
  const show = typeof open === "boolean" ? open : $("key-panel").hidden;
  $("key-panel").hidden = !show;
  $("key-toggle").setAttribute("aria-expanded", String(show));
  if (show) $("api-key").focus();
}

function setMetric(id, value, description = "estimated tokens") {
  const note = document.createElement("span");
  note.textContent = description;
  $(id).replaceChildren(document.createTextNode(number(value)), note);
}

function sourceItems(source) {
  if (Array.isArray(source))
    return source.map((item, index) =>
      typeof item === "string"
        ? { id: `source-${index + 1}`, text: item }
        : item,
    );
  if (typeof source === "string") return [{ id: "Source", text: source }];
  return [];
}

function renderSource(items, unavailable = false) {
  const parent = $("source-items");
  parent.replaceChildren();
  if (!items.length) {
    const message = document.createElement("p");
    message.className = "source-placeholder";
    message.textContent = "This scenario has no source to display.";
    parent.append(message);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "source-item";
    const meta = document.createElement("div");
    meta.className = "source-item-meta";
    const id = document.createElement("span");
    id.textContent = item.id || "Source";
    meta.append(id);
    if (["admit", "omit", "recover"].includes(item.decision)) {
      const tag = document.createElement("span");
      tag.className = `decision-tag decision-${unavailable ? "keep" : item.decision}`;
      tag.textContent = unavailable
        ? "Kept"
        : {
            admit: "Admitted",
            omit: "Omitted",
            recover: "Recovered",
          }[item.decision];
      meta.append(tag);
    }
    if (!unavailable && typeof item.score === "number") {
      const score = document.createElement("span");
      score.textContent = `Score ${item.score.toFixed(2)}`;
      meta.append(score);
    }
    if (!unavailable && typeof item.confidence === "number") {
      const confidence = document.createElement("span");
      confidence.textContent = `${Math.round(item.confidence * 100)}% conf.`;
      meta.append(confidence);
    }
    const content = document.createElement("div");
    content.className = "source-text";
    content.textContent = String(item.text ?? "");
    row.append(meta, content);
    parent.append(row);
  }
}

function renderStrip(admission = null) {
  const after = document.querySelector(".strip-after");
  after.replaceChildren();
  after.classList.toggle("is-pending", !admission);
  if (!admission) {
    for (let i = 0; i < 4; i++) after.append(document.createElement("i"));
    return;
  }
  const offered = Math.max(0, Number(admission.offeredTokens) || 0);
  const admitted = Math.max(0, Number(admission.admittedTokens) || 0);
  const recovered = Math.max(0, Number(admission.recoveredTokens) || 0);
  const total = Math.max(offered, admitted + recovered, 1);
  if (admitted > 0) {
    const chunk = document.createElement("i");
    chunk.style.flex = String(admitted / total);
    after.append(chunk);
  }
  if (recovered > 0) {
    const chunk = document.createElement("i");
    chunk.className = "is-recovered";
    chunk.style.flex = String(recovered / total);
    after.append(chunk);
  }
  const remaining = total - admitted - recovered;
  if (remaining > 0) {
    const empty = document.createElement("i");
    empty.className = "strip-empty";
    empty.style.flex = String(remaining / total);
    after.append(empty);
  }
}

function selectScenario(id) {
  state.scenario =
    state.status?.scenarios?.find((item) => item.id === id) || null;
  state.lastResult = null;
  $("scenario-description").textContent = state.scenario?.description || "";
  $("task-prompt").textContent =
    state.scenario?.prompt ||
    "Choose a scenario to inspect its prompt and source.";
  $("results").hidden = true;
  $("routing-result").hidden = true;
  $("admission-caption").textContent = "Waiting for a preview";
  $("quality-note").textContent =
    "Task quality still needs a Claude comparison.";
  $("admission-scope").textContent =
    "Source estimates only. Claude's full requests are measured separately.";
  $("source-note").textContent =
    "These fixtures contain synthetic data. JEV receives the prompt and source when you run a test.";
  setMetric("metric-offered", null);
  setMetric("metric-admitted", null);
  setMetric("metric-recovered", null);
  renderStrip();
  renderSource(sourceItems(state.scenario?.source));
  updateControls();
}

async function startRun(mode) {
  if (state.run || !state.scenario) return;
  setError(null);
  selectScenario(state.scenario.id);
  const settings = testSettings();
  state.run = { id: null, mode, ...settings };
  state.startedAt = Date.now();
  $("run-progress").hidden = false;
  $("run-phase").textContent =
    mode === "preview"
      ? "Asking JEV what belongs in this context…"
      : "Starting the paired Claude comparison…";
  $("run-elapsed").textContent = "";
  $("cancel-run").disabled = true;
  $("cancel-run").textContent = "Cancel test";
  updateControls();
  try {
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        scenarioId: state.scenario.id,
        mode,
        ...settings,
      }),
    });
    startPolling({ ...run, mode, ...settings });
  } catch (error) {
    finishError(error.message);
  }
}

function startPolling(run) {
  if (!run.id) {
    finishError(
      "The server did not return a run ID. Refresh the connection and try again.",
    );
    return;
  }
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
    $("run-phase").textContent = run.phase || "The test is running…";
    $("run-elapsed").textContent = duration(Date.now() - state.startedAt);
    if (run.status === "complete") {
      state.lastResult = run.result || {};
      renderResult(state.lastResult, state.run.mode);
      finishRun();
    } else if (run.status === "cancelled") {
      finishError(
        "Test cancelled. Calls already sent may still use JEV credits or Claude allowance.",
      );
    } else if (run.status === "error") {
      const error =
        typeof run.error === "string"
          ? run.error
          : run.error?.message ||
            "The test could not finish. Check your connection and account allowance, then try again.";
      finishError(
        /run cancelled/i.test(error)
          ? "Test cancelled. Calls already sent may still use JEV credits or Claude allowance."
          : error,
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
  setError(message);
}

function renderAnswer(prefix, answer = {}) {
  const models = Array.isArray(answer.models)
    ? answer.models.filter((model) => typeof model === "string")
    : [];
  $(`${prefix}-model-label`).textContent = models.length
    ? models.join(" · ")
    : "Actual model unavailable";
  $(`${prefix}-output`).textContent =
    typeof answer.output === "string" ? answer.output : "No response recorded.";
  const checks = $(`${prefix}-checks`);
  checks.replaceChildren();
  for (const check of answer.checks || []) {
    const label = document.createElement("span");
    label.className = `check${check.passed ? "" : " is-fail"}`;
    label.textContent = `${check.passed ? "✓" : "×"} ${check.label}`;
    checks.append(label);
  }
  const usage = answer.usage || {};
  const values = [
    ["Uncached input", number(usage.inputTokens)],
    ["Output tokens", number(usage.outputTokens)],
    ["Cache read", number(usage.cacheReadTokens)],
    ["Cache write", number(usage.cacheWriteTokens)],
    ["Elapsed", duration(answer.latencyMs)],
  ];
  const list = $(`${prefix}-usage`);
  list.replaceChildren();
  for (const [label, value] of values) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  }
}

function renderResult(result, fallbackMode) {
  applyTestSettings(result);
  const resultScenario = state.status?.scenarios?.find(
    (item) => item.id === result.scenarioId,
  );
  if (resultScenario && state.scenario?.id !== resultScenario.id) {
    state.scenario = resultScenario;
    $("scenario").value = resultScenario.id;
    $("scenario-description").textContent = resultScenario.description || "";
    $("task-prompt").textContent = resultScenario.prompt || "";
  }
  const admission = result.admission || {};
  const mode =
    result.mode ||
    fallbackMode ||
    (result.baseline || result.filtered ? "compare" : "preview");
  const compared = mode === "compare";
  const jev = result.jev || {};
  const unavailable =
    jev.status === "unavailable" ||
    (mode === "preview" &&
      jev.requests === null &&
      jev.inputTokens === null &&
      jev.costUsd === null);
  const candidates = Array.isArray(admission.candidates)
    ? admission.candidates
    : sourceItems(state.scenario?.source);
  const sourceWasKept =
    candidates.length > 0 &&
    candidates.every((item) => item.decision === "admit");
  const contextUnavailable =
    admission.status === "unavailable" ||
    (admission.status === undefined && unavailable && sourceWasKept);
  $("quality-note").textContent = compared
    ? "Task checks and actual usage are shown below."
    : "Task quality still needs a Claude comparison.";
  $("results").hidden = false;
  $("comparison").hidden = !compared;
  $("result-mode").textContent = compared
    ? "Paired Claude comparison"
    : "JEV preview";
  $("admission-caption").textContent =
    admission.status === "disabled"
      ? "Original context used"
      : contextUnavailable
        ? "Original source kept"
        : compared
          ? "Admission used in this comparison"
          : "Live JEV decision";
  $("admission-scope").textContent =
    typeof admission.scope === "string" && admission.scope
      ? admission.scope
      : compared
        ? "Selected source only. Complete Claude usage is shown below."
        : "Source selection preview. Claude has not run.";
  setMetric("metric-offered", admission.offeredTokens);
  setMetric("metric-admitted", admission.admittedTokens);
  setMetric("metric-recovered", admission.recoveredTokens);
  renderStrip(admission);
  renderSource(candidates, contextUnavailable);
  $("source-note").textContent =
    "Scores and confidence are model judgments, not correctness guarantees. These fixtures contain synthetic data.";
  $("jev-model").textContent = jev.model || state.status?.model || "JEV";
  $("jev-availability").hidden = !unavailable && jev.status !== "not-needed";
  $("jev-availability").textContent = unavailable
    ? "Unavailable · usage unknown"
    : "No JEV call needed";
  $("jev-cost-label").textContent = "estimated total JEV cost";
  $("jev-requests").textContent = number(jev.requests);
  $("jev-tokens").textContent = number(jev.inputTokens);
  $("jev-latency").textContent = duration(jev.latencyMs);
  $("jev-cost").textContent = money(jev.costUsd);
  const verdict = result.verdict || {};
  const passed = typeof verdict.passed === "boolean" ? verdict.passed : null;
  $("verdict").className =
    `verdict${passed === true ? " is-pass" : passed === false ? " is-fail" : unavailable ? " is-inconclusive" : ""}`;
  $("verdict-symbol").textContent =
    passed === true ? "✓" : passed === false ? "×" : "·";
  $("verdict-title").textContent = compared
    ? passed === true
      ? "Fixture checks passed"
      : passed === false
        ? "A fixture check failed"
        : "Comparison inconclusive"
    : unavailable
      ? "JEV preview unavailable"
      : "Preview complete";
  $("verdict-summary").textContent =
    verdict.summary ||
    (compared
      ? "Inspect both answers and the usage below. Lower context size is useful only if the task still succeeds."
      : "Inspect the admission decisions below. Run a Claude comparison to check whether the reduced context still answers the task.");
  renderRouting(result.routing);
  if (compared) {
    const orderLabels = {
      baseline: "Claude alone",
      filtered: "Claude + Jevusher",
    };
    const order = Array.isArray(result.order) ? result.order : [];
    $("comparison-order").textContent =
      order.length === 2 &&
      new Set(order).size === 2 &&
      order.every((item) => ["baseline", "filtered"].includes(item))
        ? order.map((item) => orderLabels[item]).join(" → ")
        : "Unavailable";
    $("filtered-source-label").textContent =
      result.optimization === "routing" ? "Full source" : "Admitted source";
    renderAnswer("baseline", result.baseline);
    renderAnswer("filtered", result.filtered);
  }
}

function renderRouting(routing) {
  $("routing-result").hidden = !routing;
  if (!routing) return;
  $("routing-baseline").textContent = modelName(routing.baselineModel);
  $("routing-selected").textContent = modelName(routing.selectedModel);
  $("routing-status").textContent =
    routing.trusted === true
      ? "JEV model choice used"
      : "Baseline model retained";
  $("routing-reason").textContent =
    typeof routing.reason === "string"
      ? routing.reason
      : "Inspect the paired task checks before judging the model choice.";
  $("routing-confidence").textContent =
    typeof routing.confidence === "number" &&
    Number.isFinite(routing.confidence)
      ? `${Math.round(routing.confidence * 100)}%`
      : "Unavailable";
  $("routing-cost").textContent = money(routing.costUsd);
  $("routing-tier").textContent =
    typeof routing.tier === "string" ? routing.tier : "Unavailable";
  $("routing-requests").textContent = number(routing.requests);
  $("routing-tokens").textContent = number(routing.inputTokens);
  $("routing-latency").textContent = duration(routing.latencyMs);
}

$("key-toggle").addEventListener("click", () => toggleKeyPanel());
$("refresh-status").addEventListener("click", () => {
  void refreshStatus();
});
$("scenario").addEventListener("change", (event) =>
  selectScenario(event.target.value),
);
for (const id of ["baseline-model", "optimization"]) {
  $(id).addEventListener("change", () => {
    selectScenario($("scenario").value);
    updateOptimizationHint();
  });
}
$("source-toggle").addEventListener("click", () => {
  const show = $("source-content").hidden;
  $("source-content").hidden = !show;
  $("source-toggle").setAttribute("aria-expanded", String(show));
  $("source-toggle").textContent = show ? "Hide source ↑" : "Show source ↓";
});
$("run-preview").addEventListener("click", () => {
  void startRun("preview");
});
$("run-compare").addEventListener("click", () => {
  void startRun("compare");
});
$("cancel-run").addEventListener("click", async () => {
  if (!state.run?.id) return;
  $("cancel-run").disabled = true;
  $("cancel-run").textContent = "Cancelling…";
  try {
    await api(`/api/runs/${encodeURIComponent(state.run.id)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    setError(error.message);
    $("cancel-run").disabled = false;
    $("cancel-run").textContent = "Cancel test";
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
  link.download = `jevusher-${state.scenario?.id || "test"}-${new Date().toISOString().slice(0, 10)}.json`;
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
      "The session key was removed. An environment key, if configured, is still available.";
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
  $("key-message").textContent = "Setting the key for this local session…";
  try {
    await api("/api/key", { method: "POST", body: JSON.stringify({ key }) });
    $("api-key").value = "";
    $("key-message").textContent =
      "Key configured. Run a preview to verify it with JEV.";
    await refreshStatus();
    toggleKeyPanel(false);
  } catch (error) {
    $("key-message").textContent = error.message;
  } finally {
    state.keyBusy = false;
    updateControls();
  }
});
void refreshStatus(true);
