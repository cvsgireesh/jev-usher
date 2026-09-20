/** Synthetic documents only. No local project, memory, or transcript discovery. */
interface FactCheck { label: string; field: string; expected: string | number | boolean }
export type LabTool = 'Read' | 'Bash' | 'Grep' | 'Glob' | 'none';
export interface LabScenario {
  id: string;
  title: string;
  description: string;
  prompt: string;
  source: string;
  tool?: LabTool;
  filename?: string;
  checks: FactCheck[];
}

const unrelated = (topic: string, count = 12) => Array.from({ length: count }, (_, i) =>
  `## ${topic} record ${i + 1}\n` +
  (`The facilities team reviewed ${topic.toLowerCase()} supplies in room ${i + 100}. ` +
  `This record concerns office furniture, catering, and paper inventory. It has no application settings, service incidents, or software release instructions. `).repeat(4) + '\n\n').join('');

const surround = (content: string) => unrelated('Office inventory', 7) + content + '\n\n' + unrelated('Garden maintenance', 7);

const fact = (field: string, expected: FactCheck['expected'], label: string): FactCheck => ({ field, expected, label });
const scenarios: LabScenario[] = [
  {
    id: 'release', title: 'Find the release rule',
    description: 'Locate an exact release condition in a long operations document.',
    prompt: 'Read fixture.md. Extract the atlas-api rollback rule: rollback_command (exact command), metric (exact metric name), comparison (the document\'s comparison verb), threshold_percent (number), consecutive_minutes (number), and single_spike_triggers (boolean).',
    source: surround('## atlas-api release operations\nRollback command: deployctl rollback atlas-api --revision stable\nRoll back if the HTTP 5xx error rate exceeds 2.5% for 10 consecutive minutes.\nA single transient spike does not trigger rollback.\n'),
    checks: [fact('rollback_command', 'deployctl rollback atlas-api --revision stable', 'Exact rollback command'), fact('metric', 'HTTP 5xx error rate', 'Correct error metric'), fact('comparison', 'exceeds', 'Threshold direction'), fact('threshold_percent', 2.5, 'Threshold preserved'), fact('consecutive_minutes', 10, 'Consecutive duration'), fact('single_spike_triggers', false, 'Transient spike exception')],
  },
  {
    id: 'incident', title: 'Diagnose the failed job',
    description: 'Keep the failure, its cause, and its remediation together.',
    prompt: 'Read fixture.md. For QX-71 return error_code (exact literal), configuration (exact KEY=value change), renewal_required (boolean), retries_repair_certificate (boolean), and disable_tls_verification (boolean).',
    source: surround('## Incident QX-71\n2026-09-10T08:41Z job QX-71 failed with TLS_CERT_EXPIRED.\nThe server certificate expired at 08:00Z; retries cannot repair a certificate.\nSet TLS_CERT_PATH=/etc/atlas/certs/current.pem after renewing the certificate.\nDo not disable TLS verification.\n'),
    checks: [fact('error_code', 'TLS_CERT_EXPIRED', 'Correct error code'), fact('configuration', 'TLS_CERT_PATH=/etc/atlas/certs/current.pem', 'Exact configuration'), fact('renewal_required', true, 'Certificate renewal required'), fact('retries_repair_certificate', false, 'No ineffective retry advice'), fact('disable_tls_verification', false, 'TLS safety constraint')],
  },
  {
    id: 'constraints', title: 'Preserve distant constraints',
    description: 'Useful facts sit at both ends; the filter must keep the material between them.',
    prompt: 'Read fixture.md. Return support_contact (exact email) and maximum_retention_days (number) for audit exports.',
    source: '## Audit export support\nFor audit export support contact audit-help@example.invalid.\n\n' + unrelated('Office inventory', 14) + '## Audit export retention\nAudit exports must be deleted after 17 days.\n',
    checks: [fact('support_contact', 'audit-help@example.invalid', 'Support contact preserved'), fact('maximum_retention_days', 17, 'Retention preserved')],
  },
  {
    id: 'correction', title: 'Respect a correction',
    description: 'An older limit and its replacement both matter to the answer.',
    prompt: 'Read fixture.md. Return current_requests_per_second and superseded_requests_per_second as numbers. Associate each value with the correct policy version.',
    source: surround('## API burst limit: original policy\nThe original API burst limit was 40 requests per second.\n\n## API burst limit: correction effective September 15\nThe current API burst limit is 75 requests per second. This replaces the earlier 40 requests per second.\n'),
    checks: [fact('current_requests_per_second', 75, 'Current limit'), fact('superseded_requests_per_second', 40, 'Superseded limit')],
  },
  {
    id: 'unicode', title: 'Keep exact Unicode text',
    description: 'Preserve a literal label and identifier without rewriting them.',
    prompt: 'Read fixture.md. Return display_label and deployment_identifier as exact strings, preserving accents and symbols without translation or normalization.',
    source: surround('## Display configuration\nApproved display label: Café → 東京\nDeployment identifier: zürich-β-2049\nThese literals must be copied exactly; do not translate or normalize them.\n'),
    checks: [fact('display_label', 'Café → 東京', 'Display label unchanged'), fact('deployment_identifier', 'zürich-β-2049', 'Identifier unchanged')],
  },
  {
    id: 'small', title: 'Leave short output alone',
    description: 'A short useful document should pass through without a JEV request.',
    prompt: 'Read fixture.md. Return port as a number, health_path as an exact string, and use_production_endpoint as a boolean.',
    source: '## Local probe\nUse port 4318 and path /healthz.\nDo not use the production endpoint.\n',
    checks: [fact('port', 4318, 'Port preserved'), fact('health_path', '/healthz', 'Health path preserved'), fact('use_production_endpoint', false, 'Local endpoint constraint')],
  },
  {
    id: 'job-log', title: 'Trace the terminal failure',
    description: 'Distinguish a recovered transient error from the failure that stopped the job.',
    prompt: 'Read the complete fixture.md job log. For job PX-42 return transient_error, terminal_error, failed_step, and required_action as exact documented strings, and retry_allowed as a boolean.',
    source: Array.from({ length: 40 }, (_, i) => `2026-09-10T08:00:${String(i).padStart(2, '0')}Z job AUX-${i} INFO cache-cleanup completed; removed temporary build cache.\n`).join('') +
      '\n2026-09-10T08:41:00Z job PX-42 WARN step=download transient_error=HTTP_429; retry scheduled.\n' +
      '2026-09-10T08:41:10Z job PX-42 INFO step=download retry succeeded; HTTP_429 recovered.\n' +
      '2026-09-10T08:41:11Z job PX-42 ERROR failed_step=verify terminal_error=SHA256_MISMATCH; job stopped.\n' +
      '2026-09-10T08:41:12Z job PX-42 POLICY required_action="quarantine artifact" retry_allowed=false; do not deploy this artifact.\n\n' +
      Array.from({ length: 40 }, (_, i) => `2026-09-10T09:00:${String(i).padStart(2, '0')}Z job AUX-${i + 40} INFO metrics uploaded; housekeeping complete.\n`).join(''),
    checks: [fact('transient_error', 'HTTP_429', 'Recovered transient error'), fact('terminal_error', 'SHA256_MISMATCH', 'Actual terminal failure'), fact('failed_step', 'verify', 'Correct failed step'), fact('required_action', 'quarantine artifact', 'Required remediation'), fact('retry_allowed', false, 'Retry prohibition')],
  },
  {
    id: 'complete-review', title: 'Review the complete policy',
    description: 'Every section contains a required policy rule or exception; all must survive.',
    prompt: 'Read and review the ENTIRE fixture.md policy, including every section and exception. Return support_contact (email), standard_retention_days and incident_retention_days (numbers), public_export_allowed and approval_required (booleans), approval_role (exact role), and deletion_evidence (exact artifact name). Do not narrow the review to a single section.',
    source: [
      ['Support', 'support_contact=audit-help@example.invalid', 'Questions about audit exports must reach this support contact. Owners must be identifiable before a request can proceed.'],
      ['Standard retention', 'standard_retention_days=17', 'Routine audit exports expire under the standard retention schedule. This rule applies to routine cases, not the incident exception described separately.'],
      ['Incident exception', 'incident_retention_days=31', 'Incident investigations have an explicit retention exception. A complete policy review must preserve this exception instead of applying the routine schedule to investigations.'],
      ['Public distribution', 'public_export_allowed=false', 'Audit exports are private material. Public distribution remains forbidden even when the export itself has approval.'],
      ['Approval', 'approval_required=true\napproval_role=security owner', 'An approved request identifies the accountable security owner. Approval does not remove the retention deadline or authorize public distribution.'],
      ['Deletion evidence', 'deletion_evidence=deletion-receipt.json', 'The deletion evidence must be retained after the export itself is deleted. This artifact records completion without retaining the contents of the export.'],
    ].map(([title, fields, explanation]) => `## ${title}\n${fields}\n${Array(6).fill(explanation).join('\n')}\n\n`).join(''),
    checks: [fact('support_contact', 'audit-help@example.invalid', 'Support owner preserved'), fact('standard_retention_days', 17, 'Standard retention'), fact('incident_retention_days', 31, 'Incident exception'), fact('public_export_allowed', false, 'Public distribution restriction'), fact('approval_required', true, 'Approval requirement'), fact('approval_role', 'security owner', 'Approval authority'), fact('deletion_evidence', 'deletion-receipt.json', 'Deletion evidence')],
  },
  {
    id: 'source-code', title: 'Read a TypeScript configuration', tool: 'Read', filename: 'fixture.ts',
    description: 'Read actual source code and preserve the values and exception in an exported policy.',
    prompt: 'Use Read to read all of fixture.ts. Extract the deploymentPolicy values max_retries (number), retry_delay_ms (number), and allow_tls_bypass (boolean). Also return retry_at_limit (boolean): whether shouldRetry(3) returns true. Inspect the actual implementation rather than guessing from names.',
    source: Array.from({ length: 45 }, (_, i) => `export const officeSupply${i} = { room: ${100 + i}, label: "paper inventory", quantity: ${i + 10}, department: "facilities" };\n`).join('') +
      '\nexport const deploymentPolicy = Object.freeze({ maxRetries: 3, retryDelayMs: 250, allowTlsBypass: false });\n' +
      'export function shouldRetry(attempt: number): boolean { return attempt < deploymentPolicy.maxRetries; }\n\n' +
      Array.from({ length: 45 }, (_, i) => `export const gardenSupply${i} = { shed: ${i + 1}, label: "planter inventory", quantity: ${i + 20}, department: "grounds" };\n`).join(''),
    checks: [fact('max_retries', 3, 'Retry count'), fact('retry_delay_ms', 250, 'Retry delay'), fact('allow_tls_bypass', false, 'TLS constraint'), fact('retry_at_limit', false, 'Boundary condition')],
  },
  {
    id: 'bash-output', title: 'Select useful terminal output', tool: 'Bash', filename: 'fixture.log',
    description: 'Run a fixed read-only cat command and keep the requested configuration from its output.',
    prompt: 'Use Bash to run exactly cat fixture.log. From the complete output, return atlas_probe_port (number), atlas_probe_path (exact string), and atlas_probe_method (exact string). This task must use the Bash output, not a direct Read of the log.',
    source: Array.from({ length: 45 }, (_, i) => `INFO housekeeping warehouse=${i + 1} inventory="paper, chairs, pens" count=${i + 40}; routine facilities inventory completed.\n`).join('') +
      '\nINFO atlas local probe configuration: atlas_probe_port=4318 atlas_probe_path=/healthz atlas_probe_method=GET\n\n' +
      Array.from({ length: 45 }, (_, i) => `INFO garden_report section=${i + 1} inventory="pots, soil, seedlings" count=${i + 20}; routine grounds inventory completed.\n`).join(''),
    checks: [fact('atlas_probe_port', 4318, 'Probe port'), fact('atlas_probe_path', '/healthz', 'Probe path'), fact('atlas_probe_method', 'GET', 'Probe method')],
  },
  {
    id: 'grep-output', title: 'Inspect native search results', tool: 'Grep', filename: 'fixture-search.log',
    description: 'Search a synthetic log with the native Grep tool and preserve the requested service facts.',
    prompt: 'Use the Grep tool with pattern RECORD, path fixture-search.log, output_mode content, line numbers enabled (-n=true), and head_limit=0. Return atlas_pool_size (number), atlas_region (exact string), and atlas_read_only (boolean) from the atlas database record. Use the Grep results, not a direct Read of the log.',
    source: Array.from({ length: 45 }, (_, i) => `RECORD facilities office=${i + 1} supplies="paper, chairs, pens" count=${i + 40}; routine facilities inventory completed.`).join('\n') +
      '\nRECORD atlas database: atlas_pool_size=12 atlas_region=us-central atlas_read_only=true\n' +
      Array.from({ length: 45 }, (_, i) => `RECORD grounds garden=${i + 1} supplies="pots, soil, seedlings" count=${i + 20}; routine grounds inventory completed.`).join('\n') + '\n',
    checks: [fact('atlas_pool_size', 12, 'Connection pool size'), fact('atlas_region', 'us-central', 'Database region'), fact('atlas_read_only', true, 'Read-only constraint')],
  },
  {
    id: 'glob-output', title: 'Find a source file by name', tool: 'Glob',
    description: 'Use a real native Glob result with exact synthetic paths. No source file contents are needed.',
    prompt: 'Use Glob with pattern fixtures/**/*.ts. Find the atlas audit export retention policy module and return policy_path as the exact relative path beginning fixtures/. Do not read any source files.',
    source: [
      ...Array.from({ length: 45 }, (_, i) => `fixtures/facilities/office_inventory_room_${String(i + 1).padStart(3, '0')}_paper_chairs_stationery_count_report.ts`),
      'fixtures/services/atlas-audit-export-retention-policy.ts',
      ...Array.from({ length: 45 }, (_, i) => `fixtures/grounds/garden_inventory_section_${String(i + 1).padStart(3, '0')}_soil_planters_seedlings_count_report.ts`),
    ].join('\n'),
    checks: [fact('policy_path', 'fixtures/services/atlas-audit-export-retention-policy.ts', 'Exact source path')],
  },
  {
    id: 'inline-knowledge', title: 'Route a simple question', tool: 'none',
    description: 'A short general-knowledge question needs no tools or source filtering. Test model routing alone.',
    prompt: 'Without using any tools, return the capital of France in the capital field as its English name.',
    source: '',
    checks: [fact('capital', 'Paris', 'Correct capital')],
  },
];

export const LAB_SCENARIOS: LabScenario[] = scenarios.map(scenario => ({
  ...scenario,
  tool: scenario.tool ?? 'Read',
  filename: scenario.filename ?? (scenario.tool === 'Glob' || scenario.tool === 'none' ? undefined : 'fixture.md'),
  prompt: `${scenario.prompt}\nReturn ONLY one JSON object with exactly these keys: ${scenario.checks.map(c => c.field).join(', ')}. Use the requested JSON value types. No explanation or additional fields.`,
}));

/** Literal fixture assertions, not a model judge or general answer-quality score. */
export function checkAnswer(scenario: LabScenario, answer: string) {
  const parsed = flatJsonObject(answer);
  const keys = scenario.checks.map(check => check.field);
  const formatValid = parsed !== null && Object.keys(parsed).length === keys.length && Object.keys(parsed).every(key => keys.includes(key));
  return [
    { label: 'Requested JSON fields only', passed: formatValid },
    ...scenario.checks.map(check => ({ label: check.label, passed: parsed !== null && Object.hasOwn(parsed, check.field) && parsed[check.field] === check.expected })),
  ];
}

function flatJsonObject(answer: string): Record<string, unknown> | null {
  const source = answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => v !== null && typeof v === 'object')) return null;
    // Reject repeated keys: JSON.parse would otherwise hide a contradictory
    // first value behind a correct last value in the displayed answer.
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^{}\[\]:,\s]+/g) ?? [];
    const seen = new Set<string>();
    for (let i = 1; i < tokens.length - 1; i += 4) {
      const key: unknown = JSON.parse(tokens[i]!);
      if (typeof key !== 'string' || seen.has(key)) return null;
      seen.add(key);
    }
    return value as Record<string, unknown>;
  } catch { return null; }
}
