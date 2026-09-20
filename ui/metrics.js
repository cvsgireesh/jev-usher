const nonnegative = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function tokenTotal(usage) {
  const values = [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
  ];
  if (!values.every(nonnegative)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function checkCounts(checks) {
  if (
    !Array.isArray(checks) ||
    checks.length === 0 ||
    !checks.every((check) => typeof check?.passed === "boolean")
  ) {
    return { passed: null, total: null };
  }
  return {
    passed: checks.filter((check) => check.passed).length,
    total: checks.length,
  };
}

function difference(before, after, verified) {
  if (before === null || after === null) {
    return { before, after, saved: null, percent: null, tone: "unknown" };
  }
  const saved = before - after;
  const percentage = before > 0 ? (saved / before) * 100 : null;
  return {
    before,
    after,
    saved,
    percent: Number.isFinite(percentage) ? percentage : null,
    tone:
      saved < 0
        ? "worse"
        : saved > 0 && verified
          ? "benefit"
          : "neutral",
  };
}

/** Whole-run measurements; source excerpts cannot establish overall savings. */
export function comparisonMetrics(result) {
  const baseline = checkCounts(result?.baseline?.checks);
  const filtered = checkCounts(result?.filtered?.checks);
  const completeChecks = baseline.total !== null && filtered.total !== null;
  const literalPass =
    completeChecks &&
    baseline.passed === baseline.total &&
    filtered.passed === filtered.total;
  const verdict = result?.verdict?.passed;
  const passed = !completeChecks
    ? null
    : !literalPass || verdict === false
      ? false
      : verdict === true
        ? true
        : null;

  const beforeTime = nonnegative(result?.baseline?.latencyMs)
    ? result.baseline.latencyMs
    : null;
  const filteredTime = result?.filtered?.latencyMs;
  const routingTime =
    result?.routing === undefined || result.routing === null
      ? 0
      : result.routing.latencyMs;
  const afterTime =
    nonnegative(filteredTime) &&
    nonnegative(routingTime) &&
    Number.isFinite(filteredTime + routingTime)
      ? filteredTime + routingTime
      : null;

  return {
    tokens: difference(
      tokenTotal(result?.baseline?.usage),
      tokenTotal(result?.filtered?.usage),
      passed === true,
    ),
    time: difference(beforeTime, afterTime, passed === true),
    quality: {
      baselinePassed: baseline.passed,
      baselineTotal: baseline.total,
      filteredPassed: filtered.passed,
      filteredTotal: filtered.total,
      passed,
    },
    jevCost:
      result?.jev?.status !== "unavailable" && nonnegative(result?.jev?.costUsd)
        ? result.jev.costUsd
        : null,
  };
}
