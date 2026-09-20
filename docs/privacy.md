# Data handling

jev-usher runs locally but uses TypeSafe's hosted JEV model. Local execution does
not make its judgments local inference.

## What is sent

Library calls send the state and questions supplied to the relevant lens.
The prompt hook sends your prompt and explicitly configured memory/catalog
records. Optional routing can include caller-supplied project context.
Launcher routing sends the initial launch prompt to TypeSafe. Filtering sends
eligible tool text and captured user prompts when
`JEVUSHER_FILTER=1`; MCP filtering also requires the exact-name
`JEVUSHER_FILTER_TOOLS` allowlist. Screening sends selected external tool text
only when `JEVUSHER_SCREEN=1`; MCP screening additionally requires the separate
`JEVUSHER_MCP_TOOLS` allowlist. These controls are independent.

No automatic traversal of home directories, Claude transcripts, memory
databases, or installed skills occurs. There is no analytics endpoint or cache
sharing service. The default API endpoint is `https://api.typesafe.ai/v1`;
library callers can explicitly configure another provider or base URL.

Keep secrets and material you cannot share out of these inputs. The optional
memory cache does not make a cloud request private: a cache miss still sends
state to the configured provider. TypeSafe's retention and training terms are
its own; see [TypeSafe legal documentation](https://docs.typesafe.ai/legal).

## What stays on disk

The JSONL ledger holds estimated token counts, JEV usage, lens names, timestamps,
and hook session IDs. It does not intentionally log prompts, source content,
responses, or API keys. New files are created with owner-only permissions; existing
file modes are not changed. Protect the configured store directory appropriately.
There is no automatic deletion of ledger history. Rotate or delete it to reset history;
files above 8 MB are refused on read. Original memory/catalog files remain until
you remove them. Keep them outside source control.

Settings installation creates a local backup of existing settings before editing
and keeps it beside the settings file. Settings may themselves contain private
configuration; review backups before sharing a project.

When filtering is enabled, jev-usher saves captured user prompts in its local
session state and original filtered tool text in recovery files under
`JEVUSHER_HOME`. These contain content, unlike the counts-only ledger. Prompts
are used for up to 24 hours after the last captured prompt and capped at 8 KB per
session. Expired session files remain on disk until you delete them. Recovery files are
retained until you delete them so references in existing conversations stay
usable. Delete them only when the relevant conversations no longer need them.
The `read-guards` directory contains source and recovery paths and a content
fingerprint for outstanding recovery requirements. Clear a requirement by
reading its full archive before a native edit; do not delete active guard files
to make an excerpt appear complete.
New storage is owner-only. Filtering refuses session/recovery directories that
are symlinks or accessible to other users. Do not publish these files or commit
the store directory.

## Local test UI

The UI listens on `127.0.0.1` and runs synthetic scenarios. A key supplied through
the browser goes to the local server and stays in process memory. Configured keys
are not returned by the server or stored in browser storage. No call starts
automatically when you open the UI.

JEV receives the synthetic text being evaluated. A paired Claude test sends its
synthetic task through the installed official CLI, using that CLI's saved login.
jev-usher does not extract or copy authentication tokens. The comparison disables
session persistence and uses an isolated temporary workspace and test settings.
Temporary test files are removed after each run completes or is cancelled;
an abrupt process or machine crash can leave temporary files for manual cleanup.
The UI keeps at most 30 run records in server memory. Downloaded reports persist
wherever your browser saves them.

See the [local UI guide](local-ui.md) for setup and interpreting comparisons.

The optional `DecisionCache` is process-local and stores validated decisions and
SHA-256 request fingerprints, not raw request text. It has a TTL and entry bound,
no persistence, and no export or sharing function. A hash is not encryption and
is not a reason to publish private-state fingerprints.

Tests use dummy keys and synthetic data. Live evaluations use paid API calls only
when explicitly invoked and write results outside the repository.
