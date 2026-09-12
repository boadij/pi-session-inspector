# Pi Session Inspector

`pi-session-inspector` adds one model-callable Pi extension tool, `session_inspect`, for bounded, branch-aware inspection of the active session or an explicitly supplied historical `.jsonl` session.

## Install

```bash
pi install /absolute/path/to/pi-session-inspector
```

Reload Pi after installing.

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

By default the tool inspects the active session. `session` may point explicitly to another Pi `.jsonl` session file; historical files are parsed and migrated in memory and are never rewritten.

## Typical agent workflow

```text
session_inspect(action="summary")
session_inspect(action="errors", limit=10)
session_inspect(action="search", query="src/auth.ts", limit=10)
session_inspect(action="entry", entryId="...")
```

The tool excludes its own `session_inspect` calls from tool-call statistics and its tool results from tool-result statistics; the assistant messages and usage that produced them remain normal session data. Output is bounded, redacted, and omits thinking blocks and image payloads.
