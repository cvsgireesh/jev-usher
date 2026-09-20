/** Realistic background material a coding assistant would be carrying. */

export interface Note { id: string; text: string }
export interface Tool {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  /**
   * The parameter documentation a real tool ships with. This is the part nobody
   * counts: a loaded agent carries dozens of these in every single request.
   */
  schema?: string;
}

/**
 * Real MCP tools document their parameters at roughly this length. A one-line
 * summary per tool would understate a loaded agent's context by an order of
 * magnitude, so the demo carries the real thing.
 */
export function schemaFor(name: string, params: [string, string][]): string {
  const lines = params.map(([key, doc]) => `    - ${key}: ${doc}`);
  return [
    `  Parameters for ${name}:`,
    ...lines,
    "    - dryRun (boolean, optional): validate the request and report what would happen without performing it.",
    "    - timeoutMs (number, optional): abort the call after this many milliseconds. Defaults to 30000.",
    "    - requestId (string, optional): idempotency key. Repeating a call with the same key returns the original result rather than performing the action twice.",
    "  Returns: a structured result object with `ok`, `data`, and `error` fields. On failure `error.code` is one of not_found, permission_denied, rate_limited, invalid_argument, or internal. Callers should retry rate_limited with backoff and must not retry invalid_argument.",
    "  Permissions: this tool requires the caller to hold the matching scope. Calls without it fail with permission_denied and are recorded in the audit log.",
  ].join("\n");
}

/** Saved notes from months of working on one codebase. Most are irrelevant to any given turn. */
export const NOTES: Note[] = [
  { id: "n01", text: "March 2026: session cookie SameSite was tightened from Lax to Strict during the security review." },
  { id: "n02", text: "Safari's Intelligent Tracking Prevention blocks third-party cookies by default; Chrome does not." },
  { id: "n03", text: "auth/callback.ts redirects the user back to / whenever no session cookie is present on the request." },
  { id: "n04", text: "The login flow posts to /api/session, which sets the cookie and 302s to the return URL." },
  { id: "n05", text: "We dropped IE11 support in January; no polyfills remain in the bundle." },
  { id: "n06", text: "The design team uses Figma; the handoff file is called 'Web 3.0 Refresh'." },
  { id: "n07", text: "Standup moved to 9:15am on Tuesdays after the timezone complaints." },
  { id: "n08", text: "The project uses Tailwind v4; design tokens live in src/styles/theme.css." },
  { id: "n09", text: "Deploys go out via GitHub Actions to Fly.io on every merge to main." },
  { id: "n10", text: "Staging is at staging.example.com and shares the production database read replica." },
  { id: "n11", text: "We use Vitest, not Jest. The migration finished in February." },
  { id: "n12", text: "Prettier is configured with 100-column lines and no semicolon removal." },
  { id: "n13", text: "The marketing site is a separate Next.js repo; do not confuse the two." },
  { id: "n14", text: "Sentry is wired up but the release tagging has been broken since the Fly migration." },
  { id: "n15", text: "The team agreed to stop using barrel index.ts files after the circular import incident." },
  { id: "n16", text: "Postgres 16 in production; the local docker-compose still pins 15." },
  { id: "n17", text: "Rate limiting is handled at the edge by Cloudflare, not in application code." },
  { id: "n18", text: "The analytics events schema lives in a shared package called @acme/events." },
  { id: "n19", text: "Feature flags are read from LaunchDarkly at boot and cached for five minutes." },
  { id: "n20", text: "The onboarding email sequence is owned by marketing and lives in Klaviyo." },
  { id: "n21", text: "Customer support uses Intercom; the widget is loaded lazily below the fold." },
  { id: "n22", text: "We had an outage on 12 May caused by a runaway migration lock." },
  { id: "n23", text: "The mobile app is React Native and shares only the types package." },
  { id: "n24", text: "Invoices are generated nightly by a cron in the billing service." },
  { id: "n25", text: "Stripe webhooks are verified with the signing secret in STRIPE_WEBHOOK_SECRET." },
  { id: "n26", text: "The admin panel is behind Google SSO restricted to the company domain." },
  { id: "n27", text: "Images are served from a Cloudflare bucket with a one-year cache header." },
  { id: "n28", text: "We stopped using moment.js; date handling is all Temporal polyfill now." },
  { id: "n29", text: "The search feature uses Typesense, not Elasticsearch." },
  { id: "n30", text: "Localisation covers en, de and ja. Japanese line breaking needed a custom rule." },
  { id: "n31", text: "The CI cache key includes the lockfile hash and the Node major version." },
  { id: "n32", text: "PR titles must follow Conventional Commits; a bot enforces it." },
  { id: "n33", text: "The staging seed script wipes and reloads fixtures every night at 2am." },
  { id: "n34", text: "We use pnpm workspaces; npm and yarn lockfiles are gitignored deliberately." },
  { id: "n35", text: "The error boundary component swallows render errors and reports to Sentry." },
  { id: "n36", text: "Dark mode is driven by prefers-color-scheme with a manual override in localStorage." },
  { id: "n37", text: "The changelog is generated from commit messages at release time." },
  { id: "n38", text: "We have a no-console lint rule with an exception for scripts/." },
  { id: "n39", text: "The API versioning strategy is URL-based: /v1/, /v2/." },
  { id: "n40", text: "Background jobs run on BullMQ backed by the Redis instance in Fly." },
  { id: "n41", text: "The team does not squash-merge; history is kept linear via rebase." },
  { id: "n42", text: "Secrets rotate quarterly; the runbook is in Notion under Security." },
  { id: "n43", text: "We removed the GraphQL layer last year; everything is REST now." },
  { id: "n44", text: "The performance budget is 180KB of JS on the critical path." },
  { id: "n45", text: "Accessibility audits run in CI with axe-core; violations fail the build." },
  { id: "n46", text: "The pricing page A/B test concluded in favour of the three-tier layout." },
  { id: "n47", text: "Password reset tokens expire after 30 minutes and are single use." },
  { id: "n48", text: "The session cookie is named acme_sid and is set with HttpOnly and Secure." },
  { id: "n49", text: "We migrated from Auth0 to our own session handling in November." },
  { id: "n50", text: "The office wifi password changed; it is in the welcome doc, not here." },
];

/** A toolbox of the size a real assistant carries. */
export const TOOLS: Tool[] = [
  { id: "browser", name: "Browser", summary: "drive a real browser to reproduce and inspect a bug in a live page", detail: "Open pages, click, type, read the console and network tab, and take screenshots. Use it to reproduce a UI bug in a specific browser." },
  { id: "git", name: "Git history", summary: "search commit history, blame lines, and read past diffs", detail: "Find when a line changed and why, read commit messages, and compare revisions." },
  { id: "database", name: "Database", summary: "run read-only queries against the production replica" },
  { id: "logs", name: "Log search", summary: "search application and edge logs by time range and request id" },
  { id: "metrics", name: "Metrics", summary: "query latency, error rate, and throughput dashboards" },
  { id: "figma", name: "Figma", summary: "read design files, frames, and exported assets" },
  { id: "notion", name: "Notion", summary: "search internal docs, runbooks, and meeting notes" },
  { id: "jira", name: "Issue tracker", summary: "search tickets, read comments, and check sprint status" },
  { id: "slack", name: "Slack", summary: "search channel history and threads" },
  { id: "email", name: "Email", summary: "read and draft messages on the user's behalf" },
  { id: "calendar", name: "Calendar", summary: "read availability and schedule meetings" },
  { id: "xlsx", name: "Spreadsheets", summary: "read and write Excel files and CSV data" },
  { id: "pdf", name: "PDF", summary: "read PDFs and fill in form fields" },
  { id: "slides", name: "Slides", summary: "build and edit presentation decks" },
  { id: "docx", name: "Documents", summary: "read and write Word documents" },
  { id: "stripe", name: "Payments", summary: "look up charges, refunds, and subscription state" },
  { id: "sentry", name: "Error tracking", summary: "search exceptions, stack traces, and release health" },
  { id: "ci", name: "CI", summary: "read build logs and re-run failed jobs" },
  { id: "deploy", name: "Deploys", summary: "list releases and roll back to a previous version" },
  { id: "dns", name: "DNS", summary: "inspect and edit DNS records" },
  { id: "s3", name: "Object storage", summary: "list, upload, and download stored files" },
  { id: "redis", name: "Cache", summary: "inspect keys and flush cache entries" },
  { id: "queue", name: "Job queue", summary: "inspect pending, failed, and completed background jobs" },
  { id: "flags", name: "Feature flags", summary: "read and toggle feature flags per environment" },
  { id: "translate", name: "Translation", summary: "translate copy between supported locales" },
  { id: "imagegen", name: "Image generation", summary: "generate illustrations and marketing images" },
  { id: "charts", name: "Charts", summary: "render data visualisations from a dataset" },
  { id: "maps", name: "Maps", summary: "geocode addresses and render map tiles" },
  { id: "weather", name: "Weather", summary: "current conditions and forecasts by location" },
  { id: "news", name: "News", summary: "search recent news articles by topic" },
  { id: "shopify", name: "Store", summary: "manage products, orders, and inventory" },
  { id: "hubspot", name: "CRM", summary: "look up contacts, deals, and pipeline stages" },
  { id: "zendesk", name: "Support tickets", summary: "search and reply to customer support tickets" },
  { id: "twilio", name: "SMS", summary: "send text messages and check delivery status" },
  { id: "docker", name: "Containers", summary: "list, start, and inspect running containers" },
  { id: "k8s", name: "Kubernetes", summary: "inspect pods, deployments, and rollout status" },
  { id: "terraform", name: "Infrastructure", summary: "plan and review infrastructure changes" },
  { id: "security", name: "Security scan", summary: "scan dependencies for known vulnerabilities" },
  { id: "lint", name: "Linter", summary: "run static analysis and report style violations" },
  { id: "perf", name: "Performance", summary: "run Lighthouse audits and report Core Web Vitals" },
];

/**
 * Attach realistic parameter documentation to every tool.
 *
 * Without this the demo measures a strawman: 40 one-line summaries is ~600
 * tokens, where 40 real tool definitions is ~15,000. The saving only means
 * something if the thing being saved is the real size.
 */
const PARAMS: Record<string, [string, string][]> = {
  browser: [
    ["url (string, required)", "the page to open. Must be http or https."],
    ["action (enum, required)", "one of navigate, click, type, screenshot, read_console, read_network."],
    ["selector (string, optional)", "CSS selector for click and type actions. Ignored otherwise."],
    ["text (string, optional)", "text to type. Required when action is type."],
    ["waitFor (string, optional)", "selector to wait for before returning. Fails if it does not appear."],
    ["viewport (object, optional)", "width and height in CSS pixels. Defaults to 1280x800."],
  ],
  git: [
    ["repo (string, required)", "absolute path to the repository."],
    ["operation (enum, required)", "one of log, blame, show, diff, search."],
    ["ref (string, optional)", "commit, branch, or tag. Defaults to HEAD."],
    ["path (string, optional)", "limit the operation to this file or directory."],
    ["since (string, optional)", "ISO date. Only include commits after this point."],
    ["maxResults (number, optional)", "cap the number of commits returned. Defaults to 50."],
  ],
};

const GENERIC: [string, string][] = [
  ["query (string, required)", "what to look for. Supports quoted phrases and boolean operators."],
  ["limit (number, optional)", "maximum results to return. Defaults to 25, maximum 200."],
  ["cursor (string, optional)", "pagination cursor from a previous response."],
  ["filters (object, optional)", "narrow the result set by field. Unknown fields are rejected."],
  ["fields (array, optional)", "which fields to include in each result. Defaults to all."],
  ["sort (string, optional)", "field to order by, prefixed with - for descending."],
];

for (const tool of TOOLS) {
  tool.schema = schemaFor(tool.name, PARAMS[tool.id] ?? GENERIC);
}
