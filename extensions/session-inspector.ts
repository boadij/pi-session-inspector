import { homedir } from "node:os";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "session_inspect";
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 700;
const HARD_OUTPUT_CHARS = 30_000;

type AnyEntry = Record<string, any>;
type Scope = "branch" | "all" | "context";
type Action =
  "summary" | "timeline" | "tools" | "errors" | "search" | "branches" | "entry";

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function iso(ts: unknown): string | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  try {
    return new Date(ts).toISOString();
  } catch {
    return undefined;
  }
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA[A-Z0-9]{16})\b/g, "[REDACTED_AWS_KEY]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function safeJson(value: unknown, maxChars: number): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text = JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && v.length > maxChars * 2)
        return clip(v, maxChars * 2);
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    text = String(value);
  }
  return clip(redact(text ?? ""), maxChars);
}

function textFromContent(content: unknown, maxChars: number): string {
  if (typeof content === "string") return clip(redact(content), maxChars);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    // Deliberately omit thinking and image payloads.
  }
  return clip(redact(parts.join("\n")), maxChars);
}

function toolCallsFromMessage(message: any, maxChars: number) {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  )
    return [];
  const calls: Array<{ id?: string; name?: string; arguments?: string }> = [];
  for (const block of message.content) {
    if (!block || block.type !== "toolCall") continue;
    if (block.name === TOOL_NAME) continue;
    calls.push({
      id: typeof block.id === "string" ? block.id : undefined,
      name: typeof block.name === "string" ? block.name : undefined,
      arguments: safeJson(block.arguments, maxChars),
    });
  }
  return calls;
}

function isInspectorResult(entry: AnyEntry): boolean {
  return (
    entry?.type === "message" &&
    entry?.message?.role === "toolResult" &&
    entry?.message?.toolName === TOOL_NAME
  );
}

function getEntriesForScope(manager: any, scope: Scope): AnyEntry[] {
  if (scope === "all") return manager.getEntries() as AnyEntry[];
  if (scope === "context") return manager.buildContextEntries() as AnyEntry[];
  return manager.getBranch() as AnyEntry[];
}

function messageRecord(entry: AnyEntry, maxChars: number) {
  const m = entry.message;
  if (!m) return undefined;

  if (m.role === "user") {
    return {
      id: entry.id,
      parentId: entry.parentId,
      ts: iso(m.timestamp ?? entry.timestamp),
      role: "user",
      text: textFromContent(m.content, maxChars),
    };
  }

  if (m.role === "assistant") {
    const calls = toolCallsFromMessage(m, maxChars);
    return {
      id: entry.id,
      parentId: entry.parentId,
      ts: iso(m.timestamp ?? entry.timestamp),
      role: "assistant",
      text: textFromContent(m.content, maxChars),
      ...(calls.length
        ? { tools: calls.map((c) => c.name).filter(Boolean) }
        : {}),
      ...(m.stopReason && m.stopReason !== "stop" && m.stopReason !== "toolUse"
        ? { stopReason: m.stopReason }
        : {}),
      ...(m.errorMessage
        ? { error: clip(redact(String(m.errorMessage)), maxChars) }
        : {}),
    };
  }

  if (m.role === "toolResult") {
    if (m.toolName === TOOL_NAME) return undefined;
    return {
      id: entry.id,
      parentId: entry.parentId,
      ts: iso(m.timestamp ?? entry.timestamp),
      role: "tool",
      tool: m.toolName,
      callId: m.toolCallId,
      ok: !m.isError,
      text: textFromContent(m.content, maxChars),
    };
  }

  return {
    id: entry.id,
    parentId: entry.parentId,
    ts: iso(m.timestamp ?? entry.timestamp),
    role: String(m.role ?? "message"),
    text: textFromContent(m.content, maxChars),
  };
}

function compactEntry(
  entry: AnyEntry,
  maxChars: number,
): Record<string, unknown> {
  if (entry.type === "message")
    return (
      messageRecord(entry, maxChars) ?? {
        id: entry.id,
        type: "inspector_result_omitted",
      }
    );

  const base: Record<string, unknown> = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    ts: iso(entry.timestamp),
  };

  if (entry.type === "compaction") {
    base.summary = clip(redact(String(entry.summary ?? "")), maxChars);
    base.tokensBefore = entry.tokensBefore;
    base.firstKeptEntryId = entry.firstKeptEntryId;
  } else if (entry.type === "branch_summary") {
    base.summary = clip(redact(String(entry.summary ?? "")), maxChars);
  } else if (entry.type === "model_change") {
    base.model = `${entry.provider ?? "?"}/${entry.modelId ?? "?"}`;
  } else if (entry.type === "thinking_level_change") {
    base.thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "label") {
    base.targetId = entry.targetId;
    base.label = entry.label;
  } else if (entry.type === "session_info") {
    base.name = entry.name;
  } else if (entry.type === "custom" || entry.type === "custom_message") {
    base.customType = entry.customType;
    if (entry.content)
      base.content = clip(redact(String(entry.content)), maxChars);
  }

  return base;
}

function summarize(manager: any, entries: AnyEntry[]) {
  let users = 0;
  let assistants = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let assistantErrors = 0;
  let compactions = 0;
  let branchSummaries = 0;
  let toolCalls = 0;
  const tools: Record<string, number> = {};
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (isInspectorResult(entry)) continue;
    if (entry.type === "compaction") compactions++;
    if (entry.type === "branch_summary") branchSummaries++;
    if (entry.type !== "message") continue;

    const m = entry.message;
    if (m?.role === "user") users++;
    if (m?.role === "assistant") {
      assistants++;
      if (m.stopReason === "error" || m.errorMessage) assistantErrors++;
      for (const call of toolCallsFromMessage(m, 120)) {
        if (!call.name) continue;
        toolCalls++;
        tools[call.name] = (tools[call.name] ?? 0) + 1;
      }
      if (m.usage) {
        usage.input += Number(m.usage.input ?? 0);
        usage.output += Number(m.usage.output ?? 0);
        usage.cacheRead += Number(m.usage.cacheRead ?? 0);
        usage.cacheWrite += Number(m.usage.cacheWrite ?? 0);
        usage.totalTokens += Number(m.usage.totalTokens ?? 0);
        usage.cost += Number(m.usage.cost?.total ?? 0);
      }
    }
    if (m?.role === "toolResult" && m.toolName !== TOOL_NAME) {
      toolResults++;
      if (m.isError) toolErrors++;
    }
  }

  const all = manager.getEntries() as AnyEntry[];
  const parentIds = new Set<string>();
  for (const e of all)
    if (typeof e.parentId === "string") parentIds.add(e.parentId);
  const leaves = all.filter(
    (e) => typeof e.id === "string" && !parentIds.has(e.id),
  );

  return {
    session: {
      id: manager.getSessionId(),
      name: manager.getSessionName?.(),
      cwd: manager.getCwd(),
      file: manager.getSessionFile?.(),
      persisted: manager.isPersisted?.(),
      leafId: manager.getLeafId?.(),
    },
    entries: entries.length,
    messages: { user: users, assistant: assistants, toolResult: toolResults },
    tools: { calls: toolCalls, errors: toolErrors, byName: tools },
    assistantErrors,
    compactions,
    branchSummaries,
    leaves: leaves.length,
    usage: { ...usage, cost: Number(usage.cost.toFixed(6)) },
  };
}

function toolRecords(entries: AnyEntry[], maxChars: number) {
  const calls = new Map<string, any>();
  const records: any[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = entry.message;

    if (m?.role === "assistant") {
      for (const call of toolCallsFromMessage(m, maxChars)) {
        if (!call.id || !call.name) continue;
        const rec = {
          entryId: entry.id,
          ts: iso(m.timestamp ?? entry.timestamp),
          callId: call.id,
          tool: call.name,
          arguments: call.arguments,
          status: "pending",
        };
        calls.set(call.id, rec);
        records.push(rec);
      }
    } else if (m?.role === "toolResult" && m.toolName !== TOOL_NAME) {
      let rec = calls.get(m.toolCallId);
      if (!rec) {
        rec = {
          entryId: entry.id,
          ts: iso(m.timestamp ?? entry.timestamp),
          callId: m.toolCallId,
          tool: m.toolName,
        };
        records.push(rec);
      }
      rec.resultEntryId = entry.id;
      rec.status = m.isError ? "error" : "ok";
      rec.result = textFromContent(m.content, maxChars);
    }
  }

  return records;
}

function errorRecords(entries: AnyEntry[], maxChars: number) {
  const records: any[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m?.role === "toolResult" && m.toolName !== TOOL_NAME && m.isError) {
      records.push({
        entryId: entry.id,
        ts: iso(m.timestamp ?? entry.timestamp),
        kind: "tool",
        tool: m.toolName,
        callId: m.toolCallId,
        error: textFromContent(m.content, maxChars),
      });
    }
    if (
      m?.role === "assistant" &&
      (m.stopReason === "error" || m.errorMessage)
    ) {
      records.push({
        entryId: entry.id,
        ts: iso(m.timestamp ?? entry.timestamp),
        kind: "assistant",
        stopReason: m.stopReason,
        error: clip(
          redact(
            String(m.errorMessage ?? textFromContent(m.content, maxChars)),
          ),
          maxChars,
        ),
      });
    }
  }
  return records;
}

function searchRecords(entries: AnyEntry[], query: string, maxChars: number) {
  const needle = query.toLocaleLowerCase();
  const records: any[] = [];

  for (const entry of entries) {
    if (isInspectorResult(entry)) continue;
    const haystacks: string[] = [];
    let record: Record<string, unknown> | undefined;

    if (entry.type === "message") {
      const m = entry.message;
      record = messageRecord(entry, maxChars);
      if (!record) continue;
      haystacks.push(textFromContent(m?.content, maxChars * 4));
      if (m?.role === "assistant") {
        for (const call of toolCallsFromMessage(m, maxChars * 2)) {
          haystacks.push(call.name ?? "", call.arguments ?? "");
        }
      }
      if (m?.role === "toolResult") haystacks.push(String(m.toolName ?? ""));
    } else {
      record = compactEntry(entry, maxChars);
      haystacks.push(safeJson(record, maxChars * 4));
    }

    const joined = haystacks.join("\n").toLocaleLowerCase();
    if (joined.includes(needle)) records.push(record);
  }

  return records;
}

function branchRecords(manager: any, maxChars: number) {
  const entries = manager.getEntries() as AnyEntry[];
  const byId = new Map<string, AnyEntry>();
  const parentIds = new Set<string>();
  for (const e of entries) {
    if (typeof e.id === "string") byId.set(e.id, e);
    if (typeof e.parentId === "string") parentIds.add(e.parentId);
  }
  const activeIds = new Set(
    (manager.getBranch() as AnyEntry[]).map((e) => e.id),
  );
  const leaves = entries.filter(
    (e) => typeof e.id === "string" && !parentIds.has(e.id),
  );

  function pathToRoot(leaf: AnyEntry) {
    const path: AnyEntry[] = [];
    let current: AnyEntry | undefined = leaf;
    const seen = new Set<string>();
    while (current && typeof current.id === "string" && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current =
        typeof current.parentId === "string"
          ? byId.get(current.parentId)
          : undefined;
    }
    return path.reverse();
  }

  return leaves.map((leaf) => {
    const path = pathToRoot(leaf);
    const lastMessage = [...path]
      .reverse()
      .find((e) => e.type === "message" && !isInspectorResult(e));
    return {
      leafId: leaf.id,
      active: activeIds.has(leaf.id),
      depth: path.length,
      last: lastMessage
        ? messageRecord(lastMessage, maxChars)
        : compactEntry(leaf, maxChars),
    };
  });
}

function takeWindow<T>(records: T[], limit: number, fromEnd = true): T[] {
  if (records.length <= limit) return records;
  return fromEnd
    ? records.slice(records.length - limit)
    : records.slice(0, limit);
}

function fitOutput(payload: any): string {
  let text = JSON.stringify(payload);
  if (text.length <= HARD_OUTPUT_CHARS) return text;

  if (Array.isArray(payload.records)) {
    const copy = {
      ...payload,
      truncated: true,
      totalRecords: payload.records.length,
      records: [...payload.records],
    };
    while (
      copy.records.length > 1 &&
      JSON.stringify(copy).length > HARD_OUTPUT_CHARS
    )
      copy.records.pop();
    text = JSON.stringify(copy);
    if (text.length <= HARD_OUTPUT_CHARS) return text;
  }

  return JSON.stringify({
    truncated: true,
    note: `Output exceeded ${HARD_OUTPUT_CHARS} characters. Narrow the query or lower limit/maxChars.`,
  });
}

export default function sessionInspector(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Session Inspect",
    description:
      "Efficiently inspect and analyze the current Pi session, or an explicitly specified Pi session file, without dumping raw JSONL. Returns bounded structured evidence for summaries, timelines, tools, errors, searches, branches, or individual entries.",
    promptSnippet:
      "Inspect Pi sessions with bounded, branch-aware structured output",
    promptGuidelines: [
      "Use session_inspect instead of reading raw Pi session JSONL when investigating session history, tool usage, failures, branches, compaction, or agent behavior.",
      "For session analysis, call session_inspect with action=summary first, then request only targeted evidence with errors, tools, search, timeline, branches, or entry.",
      "Prefer scope=branch for causal analysis of the active path; use scope=all only when abandoned branches matter.",
    ],
    parameters: Type.Object({
      action: StringEnum(
        [
          "summary",
          "timeline",
          "tools",
          "errors",
          "search",
          "branches",
          "entry",
        ] as const,
        {
          description:
            "Inspection operation. Start with summary for analysis tasks.",
        },
      ),
      scope: Type.Optional(
        StringEnum(["branch", "all", "context"] as const, {
          description:
            "branch=current path, all=entire session tree, context=active branch after compaction rules. Default branch.",
        }),
      ),
      session: Type.Optional(
        Type.String({
          description:
            "Optional explicit .jsonl session path. Omit to inspect the active session via ctx.sessionManager.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive substring for action=search.",
        }),
      ),
      entryId: Type.Optional(
        Type.String({ description: "Exact entry ID for action=entry." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "Maximum returned records. Default 20.",
        }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 120,
          maximum: 2000,
          description:
            "Maximum characters per text/args/result snippet. Default 700.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action as Action;
      const scope = (params.scope ?? "branch") as Scope;
      const limit = params.limit ?? DEFAULT_LIMIT;
      const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

      let manager: any = ctx.sessionManager;
      let source = "active";
      if (params.session) {
        const path = expandPath(params.session);
        if (!path.endsWith(".jsonl")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "session must point to a .jsonl Pi session file",
                }),
              },
            ],
            details: { action, scope, ok: false },
          };
        }
        manager = SessionManager.open(path);
        source = path;
      }

      const entries = getEntriesForScope(manager, scope).filter(
        (e) => !isInspectorResult(e),
      );
      let payload: any;

      switch (action) {
        case "summary":
          payload = { action, scope, source, ...summarize(manager, entries) };
          break;

        case "timeline": {
          const records = entries
            .map((e) => compactEntry(e, maxChars))
            .filter((e) => e.type !== "inspector_result_omitted");
          payload = {
            action,
            scope,
            source,
            returned: Math.min(limit, records.length),
            total: records.length,
            records: takeWindow(records, limit, true),
          };
          break;
        }

        case "tools": {
          const records = toolRecords(entries, maxChars);
          payload = {
            action,
            scope,
            source,
            returned: Math.min(limit, records.length),
            total: records.length,
            records: takeWindow(records, limit, true),
          };
          break;
        }

        case "errors": {
          const records = errorRecords(entries, maxChars);
          payload = {
            action,
            scope,
            source,
            returned: Math.min(limit, records.length),
            total: records.length,
            records: takeWindow(records, limit, true),
          };
          break;
        }

        case "search": {
          const query = params.query?.trim();
          if (!query) {
            payload = { error: "query is required for action=search" };
            break;
          }
          const records = searchRecords(entries, query, maxChars);
          payload = {
            action,
            scope,
            source,
            query,
            returned: Math.min(limit, records.length),
            total: records.length,
            records: takeWindow(records, limit, false),
          };
          break;
        }

        case "branches": {
          const records = branchRecords(manager, maxChars);
          payload = {
            action,
            source,
            returned: Math.min(limit, records.length),
            total: records.length,
            records: takeWindow(records, limit, false),
          };
          break;
        }

        case "entry": {
          const entryId = params.entryId?.trim();
          if (!entryId) {
            payload = { error: "entryId is required for action=entry" };
            break;
          }
          const entry = manager.getEntry(entryId);
          payload = entry
            ? { action, source, record: compactEntry(entry, maxChars) }
            : { error: `entry not found: ${entryId}` };
          break;
        }
      }

      return {
        content: [{ type: "text", text: fitOutput(payload) }],
        details: { action, scope, source, ok: !payload?.error },
      };
    },
  });
}
