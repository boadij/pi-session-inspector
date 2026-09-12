import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlySessionManager,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import sessionInspector from "./session-inspector.ts";

type Test = (name: string, fn: () => Promise<void>) => void;
const pendingTests: Promise<void>[] = [];
const test: Test = process.env.PI_SESSION_INSPECTOR_PI
  ? (name, fn) => {
      pendingTests.push(
        Promise.resolve()
          .then(fn)
          .then(() => console.log(`PASS ${name}`))
          .catch((error) => {
            console.error(`FAIL ${name}`, error);
            throw error;
          }),
      );
    }
  : ((await import("node:test")).test as Test);

const usage = (value: number): Usage => ({
  input: value,
  output: value,
  cacheRead: value,
  cacheWrite: value,
  totalTokens: value,
  cost: { input: value, output: value, cacheRead: value, cacheWrite: value, total: value },
});

function entry(id: string, parentId: string | null, message: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  } as SessionEntry;
}

function tool() {
  let definition: ToolDefinition | undefined;
  sessionInspector({
    registerTool(value) {
      definition = value;
    },
  } as unknown as ExtensionAPI);
  assert.ok(definition);
  return definition;
}

function output(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function manager(entries: SessionEntry[], branch: SessionEntry[], tree: unknown): ReadonlySessionManager {
  const byId = new Map(entries.map((item) => [item.id, item]));
  return {
    getCwd: () => process.cwd(),
    getSessionDir: () => "",
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
    getLeafId: () => branch.at(-1)?.id ?? null,
    getLeafEntry: () => branch.at(-1),
    getEntry: (id) => byId.get(id),
    getLabel: () => undefined,
    getBranch: () => branch,
    buildContextEntries: () => branch,
    getHeader: () => null,
    getEntries: () => entries,
    getTree: () => tree,
    getSessionName: () => undefined,
  };
}

test("inspects typed timestamps, evidence, usage, branches, and bounded tails", async () => {
  const user = entry("user", null, {
    role: "user",
    content: [{ type: "text", text: `${"x".repeat(12_000)}needle` }],
    timestamp: 1_700_000_000_000,
  });
  const assistant = entry("assistant", "user", {
    role: "assistant",
    content: [
      { type: "text", text: "running" },
      { type: "toolCall", id: "call", name: "bash", arguments: { value: `${"y".repeat(12_000)}argument-needle` } },
    ],
    usage: usage(2),
    stopReason: "toolUse",
    timestamp: 1_700_000_000_001,
  });
  const result = entry("result", "assistant", {
    role: "toolResult",
    toolCallId: "call",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    details: { result: true },
    usage: usage(3),
    isError: false,
    timestamp: 1_700_000_000_002,
  });
  const custom = {
    type: "custom",
    id: "custom",
    parentId: "result",
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "test",
    data: { marker: "custom-data-needle" },
  } as SessionEntry;
  const customMessage = {
    type: "custom_message",
    id: "custom-message",
    parentId: "custom",
    timestamp: "2026-01-01T00:00:02.000Z",
    customType: "test",
    content: "custom-message-needle",
    display: false,
  } as SessionEntry;
  const compaction = {
    type: "compaction",
    id: "compaction",
    parentId: "custom-message",
    timestamp: "2026-01-01T00:00:03.000Z",
    summary: "summary",
    firstKeptEntryId: "user",
    tokensBefore: 10,
    usage: usage(4),
  } as SessionEntry;
  const branchSummary = {
    type: "branch_summary",
    id: "branch-summary",
    parentId: "user",
    timestamp: "2026-01-01T00:00:04.000Z",
    fromId: "user",
    summary: "branch",
    usage: usage(5),
  } as SessionEntry;
  const inspectorCall = entry("inspector-call", "result", {
    role: "assistant",
    content: [{ type: "toolCall", id: "inspect-call", name: "session_inspect", arguments: {} }],
    usage: usage(99),
    stopReason: "toolUse",
    timestamp: 1_700_000_000_003,
  });
  const inspectorResult = entry("inspector-result", "inspector-call", {
    role: "toolResult",
    toolCallId: "inspect-call",
    toolName: "session_inspect",
    content: [{ type: "text", text: "internal" }],
    isError: false,
    timestamp: 1_700_000_000_004,
  });
  const alternate = entry("alternate", "assistant", {
    role: "user",
    content: [{ type: "text", text: "abandoned branch" }],
    timestamp: 1_700_000_000_005,
  });
  const entries = [user, assistant, result, alternate, custom, customMessage, compaction, branchSummary, inspectorCall, inspectorResult];
  const branch = [user, assistant, result];
  const tree = [{ entry: user, children: [{ entry: assistant, children: [{ entry: result, children: [] }, { entry: alternate, children: [] }] }] }];
  const sessionManager = manager(entries, branch, tree);
  const ctx = { sessionManager } as unknown as ExtensionContext;
  const definition = tool();
  assert.ok(definition.renderCall);
  assert.ok(definition.renderResult);
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as never;
  const renderedCall = definition.renderCall(
    { action: "search", query: "auth.ts" } as never,
    theme,
    {} as never,
  );
  assert.match(renderedCall.render(200).join("\n"), /session_inspect search "auth\.ts"/);
  const renderResult = definition.renderResult;
  const successResult = {
    content: [{ type: "text", text: '{"action":"summary","entries":3}' }],
    details: { action: "summary", ok: true, summary: "3 entries · 1 tool calls · 0 errors" },
  } as never;
  assert.match(
    renderResult(successResult, { expanded: false, isPartial: false }, theme, {} as never).render(200).join("\n"),
    /✓ 3 entries · 1 tool calls · 0 errors/,
  );
  assert.match(
    renderResult(successResult, { expanded: true, isPartial: false }, theme, {} as never).render(200).join("\n"),
    /\{"action":"summary","entries":3\}/,
  );
  const errorResult = {
    content: [{ type: "text", text: '{"error":"missing session"}' }],
    details: { action: "summary", ok: false, error: "missing session" },
  } as never;
  assert.match(
    renderResult(errorResult, { expanded: false, isPartial: false }, theme, {} as never).render(200).join("\n"),
    /✗ missing session/,
  );
  const expandedError = renderResult(errorResult, { expanded: true, isPartial: false }, theme, {} as never).render(200).join("\n");
  assert.match(expandedError, /\{"error":"missing session"\}/);
  assert.doesNotMatch(expandedError, /✗ missing session/);

  const timeline = output(await definition.execute("1", { action: "timeline", maxChars: 120 }, undefined, undefined, ctx));
  assert.equal(timeline.records[0].ts, new Date(1_700_000_000_000).toISOString());
  assert.equal(timeline.records[1].ts, new Date(1_700_000_000_001).toISOString());

  const search = output(await definition.execute("2", { action: "search", scope: "all", query: "needle", maxChars: 120 }, undefined, undefined, ctx));
  assert.ok(search.records.some((record: { match: { text: string } }) => record.match.text.includes("needle")));
  const argumentSearch = output(await definition.execute("3", { action: "search", scope: "all", query: "argument-needle", maxChars: 120 }, undefined, undefined, ctx));
  assert.equal(argumentSearch.records[0].match.field, "tool.arguments");
  assert.ok(argumentSearch.records[0].match.text.includes("argument-needle"));
  const detail = output(await definition.execute("3b", { action: "entry", entryId: "assistant", maxChars: 120 }, undefined, undefined, ctx));
  assert.equal(detail.record.toolCalls[0].name, "bash");
  assert.ok(detail.record.toolCalls[0].arguments.length <= 120);

  const summary = output(await definition.execute("4", { action: "summary", scope: "all" }, undefined, undefined, ctx));
  assert.equal(summary.usage.input, 2 + 3 + 4 + 5 + 99);
  assert.equal(summary.tools.calls, 1);
  assert.equal(summary.messages.toolResult, 1);

  const toolStats = output(await definition.execute("4b", { action: "tools", scope: "all" }, undefined, undefined, ctx));
  assert.equal(toolStats.records.length, 1);
  assert.equal(toolStats.records[0].tool, "bash");
  const errorStats = output(await definition.execute("4c", { action: "errors", scope: "all" }, undefined, undefined, ctx));
  assert.equal(errorStats.records.length, 0);
  const internalSearch = output(await definition.execute("4d", { action: "search", scope: "all", query: "internal" }, undefined, undefined, ctx));
  assert.equal(internalSearch.total, 0);
  const timelineIds = output(await definition.execute("4e", { action: "timeline", scope: "all" }, undefined, undefined, ctx)).records.map((record: { id: string }) => record.id);
  assert.equal(timelineIds.includes("inspector-result"), false);

  const customSearch = output(await definition.execute("5", { action: "search", scope: "all", query: "custom-data-needle" }, undefined, undefined, ctx));
  assert.equal(customSearch.records[0].match.field, "custom.data");
  const branches = output(await definition.execute("6", { action: "branches", scope: "all" }, undefined, undefined, ctx));
  assert.equal(branches.records.length, 2);
  const activeBranch = branches.records.find((record: { active: boolean }) => record.active);
  const inactiveBranch = branches.records.find((record: { active: boolean }) => !record.active);
  assert.equal(activeBranch.leafId, sessionManager.getLeafId());
  assert.equal(inactiveBranch.leafId, "alternate");
  assert.equal(activeBranch.active, true);
  assert.equal(inactiveBranch.active, false);

  const many = [...entries, ...Array.from({ length: 30 }, (_, index) => entry(`tail-${index}`, null, {
    role: "user",
    content: [{ type: "text", text: `${index} ${"z".repeat(2_000)}` }],
    timestamp: 1_700_000_100_000 + index,
  }))];
  const boundedResult = await definition.execute("7", { action: "timeline", scope: "all", limit: 50, maxChars: 2_000 }, undefined, undefined, { sessionManager: manager(many, branch, tree) } as unknown as ExtensionContext);
  const bounded = output(boundedResult);
  assert.equal(bounded.total, many.length - 1);
  assert.equal(bounded.truncated, true);
  assert.equal((boundedResult.details as { returned: number }).returned, bounded.returned);
  assert.match(
    renderResult(boundedResult, { expanded: false, isPartial: false }, theme, {} as never).render(200).join("\n"),
    new RegExp(`✓ ${bounded.total} timeline entries · ${bounded.returned} shown`),
  );
  assert.equal(bounded.records.at(-1).id, "tail-29");
  assert.equal(bounded.records.some((record: { id: string }) => record.id === "tail-0"), false);
  const limitedResult = await definition.execute("7b", { action: "timeline", scope: "all", limit: 1 }, undefined, undefined, { sessionManager: manager(many, branch, tree) } as unknown as ExtensionContext);
  const limitedPayload = output(limitedResult);
  assert.match(
    renderResult(limitedResult, { expanded: false, isPartial: false }, theme, {} as never).render(200).join("\n"),
    new RegExp(`✓ ${limitedPayload.total} timeline entries · 1 shown`),
  );
});

test("reads and migrates historical sessions without rewriting them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-session-inspector-"));
  try {
    const path = join(directory, "legacy.jsonl");
    const original = [
      JSON.stringify({ type: "session", version: 1, id: "legacy-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }),
      JSON.stringify({ type: "message", message: { role: "user", content: "legacy", timestamp: 1_700_000_000_000 } }),
      "",
    ].join("\n");
    writeFileSync(path, original);
    assert.notEqual(directory, process.cwd());
    const definition = tool();
    const historicalContext = {
      cwd: directory,
      sessionManager: {} as ReadonlySessionManager,
    } as unknown as ExtensionContext;
    const result = await definition.execute("8", { action: "summary", session: "legacy.jsonl" }, undefined, undefined, historicalContext);
    assert.equal(output(result).session.id, "legacy-session");
    const timeline = await definition.execute("9", { action: "timeline", session: "legacy.jsonl" }, undefined, undefined, historicalContext);
    const timelineOutput = output(timeline);
    assert.equal(timelineOutput.records.length, 1);
    assert.equal(timelineOutput.records[0].text, "legacy");
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

if (process.env.PI_SESSION_INSPECTOR_PI) {
  try {
    await Promise.all(pendingTests);
    console.log("session-inspector regression suite passed");
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
