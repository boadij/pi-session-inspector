# Pi Session Inspector

`pi-session-inspector` adds one model-callable Pi extension tool, `session_inspect`, for bounded, branch-aware inspection of the active session or a historical Pi session selected by exact session ID or `.jsonl` path. It can also query recorded tool calls across historical sessions.

## Install

```bash
pi install /absolute/path/to/pi-session-inspector
```

Reload Pi after installing.

## Tests

With Pi 1.5.2 installed and available as `pi`, run the regression suite through Pi's bundled extension loader:

```bash
npm test
```

The test command does not install or bundle Pi's peer packages.

## CI and releases

Pull requests and pushes to `main` run the regression suite on Pi 1.5.2 and check the npm package contents.

[Release Please](https://github.com/googleapis/release-please-action) prepares version/changelog PRs from Conventional Commits. Merging a release PR creates a GitHub release and publishes that version to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers/). Before the first release, enable GitHub Actions PR creation in repository settings and configure the npm package's trusted GitHub publisher as `boadij/pi-session-inspector`, workflow `release.yml`, allowing direct `npm publish`. No npm token is needed.

To retry publication of an existing release, manually run the **Release** workflow with its `vX.Y.Z` tag.

## Actions

`session_inspect` supports:

- `summary` - session metadata, message/tool counts, errors, token/cost usage, compactions, leaves
- `timeline` - bounded compact entry timeline
- `tools` - correlated tool calls/results with status
- `errors` - tool and assistant errors
- `search` - case-insensitive targeted session search
- `branches` - leaf/branch overview
- `entry` - exact bounded entry inspection

Scopes:

- `branch` - current active path, default
- `all` - entire session tree
- `context` - active branch after Pi's context/compaction rules

By default the tool inspects the active session. `session` may be an exact session ID from the current Pi project or an explicit `.jsonl` path. Historical files are parsed and migrated in memory and are never rewritten.

## Cross-session tool queries

```text
session_inspect(action="tools", history="project", tool="delegate_agent", sessionLimit=25, limit=20)
```

- `history="project"` searches the active session manager's configured directory and checks session working directories against the active project. Explicitly use `history="all-projects"` to search local Pi project directories under the Pi agent directory's `sessions` folder. Bulk discovery does not follow symlinked child directories or files.
- History mode requires `action="tools"` and a nonempty, exact, case-sensitive `tool` name. Do not supply `session`. All recorded branches are searched, including abandoned branches; omit `scope` or set it to `"all"`. The inspector's own calls are excluded. Omitting `history` preserves single-session behavior.
- `sessionLimit` bounds attempted files (default 25, max 100). `limit` bounds returned examples (default 20, max 50); the output cap may reduce that further. A call has a 128 MiB input budget. Files too large for bulk scanning are skipped and can still be inspected directly by path.
- Argument excerpts are omitted by default. Set `includeArguments=true` to request bounded, redacted excerpts (`maxChars` still controls excerpt length). Redaction is best-effort and may miss sensitive values. Tool-result bodies are never returned in history mode.

Pass `nextCursor` back as `cursor` with the same history scope, tool, and session root to continue with the remaining files. The cursor is opaque and advances by file, not by example. A page keeps at least one example per matching session it counts as scanned, deferring the next session if necessary. Other calls from a represented session are sampled, not individually paginated. If no sampled example fits even on a page of its own, the file is reported as failed and skipped so the cursor can advance. Pagination is not a snapshot: files added, deleted, or modified between pages can affect coverage. An absent cursor means there is no next page, not that all history was readable.

Each example identifies the session (`sessionId`, `sessionPath`, `parentSession`), assistant entry (`entryId`), tool call (`callId`), and any correlated result (`resultEntryId`). Status `ok` or `error` reflects Pi's tool-error flag, not whether the tool accomplished its task. `pending` means no correlated result was found in the file, not that the tool is still running.

The response reports coverage separately from examples:

| Field | Meaning |
| --- | --- |
| `discovered` | Session file candidates found during discovery. |
| `attempted`, `scanned`, `failed` | Candidates attempted, files counted as fully scanned, and file failures on this page. An attempted file deferred at the output boundary is not counted as scanned or failed and is retried on the next page. Failure diagnostics are bounded. |
| `matchingOccurrences` | Matching calls in fully scanned files on this page, including copied entries in forks. These are recorded occurrences, not unique executions. |
| `returned`, `examplesTruncated` | Examples actually emitted, and whether some matches on this page were omitted. |
| `scanComplete` | No remaining candidates, complete discovery, and no failures on this page. Check earlier pages separately. |

Unreadable, malformed, changed, or oversized files do not contribute partial match counts. Incomplete discovery or failed files can leave gaps even when every returned match is shown. Historical files remain read-only; older formats are migrated in memory.

## Typical agent workflow

```text
session_inspect(action="summary")
session_inspect(action="summary", session="0199...")
session_inspect(action="errors", limit=10)
session_inspect(action="search", query="src/auth.ts", limit=10)
session_inspect(action="entry", entryId="...")
```

The tool excludes its own `session_inspect` calls from tool-call statistics and its tool results from tool-result statistics; the assistant messages and usage that produced them remain normal session data. Output is bounded, redacted, and omits thinking blocks and image payloads.
