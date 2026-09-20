# Data handling

Jevusher runs locally but uses TypeSafe's hosted JEV model. Local execution does
not make its judgments local inference.

## What is sent

Library calls send the state and questions supplied to the relevant lens.
The prompt hook sends your prompt and explicitly configured memory/catalog
records. Optional routing can include caller-supplied project context.
Screening sends selected external tool text only when `JEVUSHER_SCREEN=1`;
MCP tools also need an exact-name `JEVUSHER_MCP_TOOLS` allowlist.

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
There is no automatic deletion. Rotate or delete the ledger to reset local history;
files above 8 MB are refused on read. Original memory/catalog files remain until
you remove them. Keep them outside source control.

Settings installation creates a local backup of existing settings before editing
and keeps it beside the settings file. Settings may themselves contain private
configuration; review backups before sharing a project.

The optional `DecisionCache` is process-local and stores validated decisions and
SHA-256 request fingerprints, not raw request text. It has a TTL and entry bound,
no persistence, and no export or sharing function. A hash is not encryption and
is not a reason to publish private-state fingerprints.

Tests use dummy keys and synthetic data. Live evaluations use paid API calls only
when explicitly invoked and write results outside the repository.
