# Pi Session Inspector Tool

A native Pi extension plus Agent Skill for efficient session inspection by the active coding agent.

## Why this shape

The extension registers one LLM-callable tool, `session_inspect`, and reads the active session directly from Pi's `ctx.sessionManager`. The skill teaches agents to start with a cheap summary and pull only the evidence needed for analysis.

It intentionally avoids dumping raw session JSONL, thinking blocks, images, and unbounded tool output into model context.

## Install locally

From the extracted directory:

```bash
pi install /absolute/path/to/pi-session-inspector-v2
```

Alternatively copy the resources manually:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills/session-inspector
cp extensions/session-inspector.ts ~/.pi/agent/extensions/session-inspector.ts
cp skills/session-inspector/SKILL.md ~/.pi/agent/skills/session-inspector/SKILL.md
```

Then run `/reload` in Pi.

## Tool

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

By default the tool inspects the active session. `session` may point explicitly to another Pi `.jsonl` session file.

## Typical agent workflow

```text
session_inspect(action="summary")
session_inspect(action="errors", limit=10)
session_inspect(action="search", query="src/auth.ts", limit=10)
session_inspect(action="entry", entryId="...")
```

The extension filters its own `session_inspect` calls/results from most analysis so repeated inspection does not pollute the session metrics.
