import { describe, expect, it } from 'vitest';
import { checkAnswer, LAB_SCENARIOS, type LabScenario } from '../src/lab-scenarios.js';

const scenario = (id: string) => LAB_SCENARIOS.find(s => s.id === id)!;
const correct = (value: LabScenario) => Object.fromEntries(value.checks.map(c => [c.field, c.expected]));
const passes = (value: LabScenario, answer: unknown) => checkAnswer(value, typeof answer === 'string' ? answer : JSON.stringify(answer)).every(c => c.passed);

describe('literal scenario checks', () => {
  it('has bounded synthetic scenarios covering each supported native tool and direct questions', () => {
    expect(LAB_SCENARIOS).toHaveLength(13);
    expect(new Set(LAB_SCENARIOS.map(s => s.id)).size).toBe(13);
    expect(new Set(LAB_SCENARIOS.map(s => s.tool))).toEqual(new Set(['Read', 'Bash', 'Grep', 'Glob', 'none']));
    for (const value of LAB_SCENARIOS) {
      expect(passes(value, correct(value))).toBe(true);
      expect(Buffer.byteLength(value.source)).toBeLessThan(120_000);
      expect(value.prompt).toContain('ONLY one JSON object');
      if (value.id !== 'small' && value.tool !== 'none') expect(Buffer.byteLength(value.source)).toBeGreaterThan(4_000);
    }
  });

  it('rejects swapped current and superseded values despite containing both numbers', () => {
    const value = scenario('correction');
    expect(passes(value, { current_requests_per_second: 40, superseded_requests_per_second: 75 })).toBe(false);
    expect(passes(value, 'The current limit is 40 and the old limit is 75.')).toBe(false);
  });

  it('rejects wrong threshold direction, metric, duration and spike contradiction', () => {
    const value = scenario('release');
    for (const patch of [{ comparison: 'below' }, { metric: 'HTTP 4xx error rate' }, { consecutive_minutes: 1 }, { threshold_percent: 25 }, { single_spike_triggers: true }]) {
      expect(passes(value, { ...correct(value), ...patch })).toBe(false);
    }
    expect(passes(value, { ...correct(value), consecutive_minutes: '10 total, not consecutive' })).toBe(false);
  });

  it('rejects unsafe TLS and retry advice despite correct cause/configuration', () => {
    const value = scenario('incident');
    for (const patch of [{ disable_tls_verification: true }, { renewal_required: false }, { retries_repair_certificate: true }]) expect(passes(value, { ...correct(value), ...patch })).toBe(false);
  });

  it('rejects lost exceptions and additional contradictory fields', () => {
    const value = scenario('complete-review');
    expect(passes(value, { ...correct(value), incident_retention_days: 17 })).toBe(false);
    expect(passes(value, { ...correct(value), public_export_allowed: true })).toBe(false);
    expect(passes(value, { ...correct(value), advice: 'Publish exports and skip approval' })).toBe(false);
  });

  it('distinguishes recovered errors from terminal failures in a long log', () => {
    const value = scenario('job-log');
    expect(passes(value, { ...correct(value), terminal_error: 'HTTP_429', transient_error: 'SHA256_MISMATCH' })).toBe(false);
    expect(passes(value, { ...correct(value), retry_allowed: true })).toBe(false);
  });

  it('requires exact Unicode and field value types', () => {
    const value = scenario('unicode');
    expect(passes(value, { ...correct(value), display_label: 'Cafe -> Tokyo' })).toBe(false);
    expect(passes(value, { ...correct(value), display_label: 'Café → 東京'.normalize('NFD') })).toBe(false);
    const small = scenario('small');
    expect(passes(small, { ...correct(small), port: '4318' })).toBe(false);
    expect(passes(small, { ...correct(small), use_production_endpoint: 'false' })).toBe(false);
  });

  it('rejects missing, duplicate, malformed, nested and explanatory answers', () => {
    const value = scenario('correction');
    for (const answer of ['{}', 'null', '[]', '{"current_requests_per_second":75}',
      '{"current_requests_per_second":40,"current_requests_per_second":75,"superseded_requests_per_second":40}',
      '{"current_requests_per_second":{"value":75},"superseded_requests_per_second":40}',
      '{"current_requests_per_second":75,"superseded_requests_per_second":40} But actually use 40.',
      '{"current_requests_per_second":75,"superseded_requests_per_second":40,}',
    ]) expect(passes(value, answer)).toBe(false);
  });

  it('accepts whitespace, field ordering, code fences and equivalent JSON escapes', () => {
    const value = scenario('correction');
    expect(passes(value, '```json\n{\n"superseded_requests_per_second": 40,\n"current_requests_per_second": 75\n}\n```')).toBe(true);
    const unicode = scenario('unicode');
    expect(passes(unicode, JSON.stringify(correct(unicode)).replace('é', '\\u00e9'))).toBe(true);
  });
});
