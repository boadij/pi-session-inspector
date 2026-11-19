import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
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
      JSON.stringify({ type: "session", version: 1, id: "legacy-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: directory }),
      JSON.stringify({ type: "message", message: { role: "user", content: "legacy", timestamp: 1_700_000_000_000 } }),
      "",
    ].join("\n");
    writeFileSync(path, original);
    assert.notEqual(directory, process.cwd());
    const definition = tool();
    const historicalContext = {
      cwd: directory,
      sessionManager: {
        getSessionDir: () => directory,
      } as ReadonlySessionManager,
    } as unknown as ExtensionContext;
    const result = await definition.execute("8", { action: "summary", session: "legacy.jsonl" }, undefined, undefined, historicalContext);
    assert.equal(output(result).session.id, "legacy-session");
    const byId = await definition.execute("8b", { action: "summary", session: "legacy-session" }, undefined, undefined, historicalContext);
    assert.equal(output(byId).session.id, "legacy-session");
    assert.equal(output(byId).source, path);
    const timeline = await definition.execute("9", { action: "timeline", session: "legacy.jsonl" }, undefined, undefined, historicalContext);
    const timelineOutput = output(timeline);
    assert.equal(timelineOutput.records.length, 1);
    assert.equal(timelineOutput.records[0].text, "legacy");
    assert.equal(readFileSync(path, "utf8"), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

test("queries bounded historical tool evidence across sessions without rewriting them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-session-inspector-history-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(directory, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const cwd = join(directory, "project");
    const otherCwd = join(directory, "other");
    const formerWorktree = join(directory, ".herdr", "worktrees", "project", "feat-gone");
    const similarlyNamed = join(directory, ".herdr", "worktrees", "project-backup", "feat-gone");
    const project = join(agentDir, "sessions", "--project--");
    const other = join(agentDir, "sessions", "--other--");
    const formerSessions = join(agentDir, "sessions", "--former--");
    const backupSessions = join(agentDir, "sessions", "--backup--");
    for (const dir of [cwd, otherCwd, project, other, formerSessions, backupSessions]) mkdirSync(dir, { recursive: true });
    const originals = new Map<string, string>();
    const timestamp = 1_700_000_000_000;
    const secret = "sk-fixture-example-not-a-real-key";
    const call = (id: string, name = "delegate_agent") => ({
      type: "toolCall",
      id,
      name,
      arguments: { token: secret, task: "x".repeat(2_000) },
    });
    const assistant = (id: string, parentId: string | null, ...content: ReturnType<typeof call>[]) =>
      entry(id, parentId, { role: "assistant", content, timestamp });
    const result = (id: string, parentId: string | null, toolCallId: string, isError: boolean) =>
      entry(id, parentId, {
        role: "toolResult", toolCallId, toolName: "delegate_agent", isError,
        content: [{ type: "text", text: "private-result-body" }], timestamp,
      });
    function writeSession(file: string, id: string, entries: unknown[], options: Record<string, unknown> = {}, sessionDir = project) {
      const path = join(sessionDir, file);
      const original = [
        JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id, cwd, timestamp: new Date(timestamp).toISOString(), ...options }),
        ...entries.map((item) => typeof item === "string" ? item : JSON.stringify(item)),
        "",
      ].join("\n");
      writeFileSync(path, original);
      originals.set(path, original);
      return path;
    }
    const largeCallId = "large-" + "x".repeat(16_000);
    const abandoned = assistant("copied-entry", null, call("copied-call"), call("not-exact", "Delegate_agent"),
      call(largeCallId, "large_tool"));
    const ok = result("ok-entry", abandoned.id, "copied-call", false);
    const branch = assistant("other-branch", abandoned.id, call("error-call"), call("pending-call"), call("self-call", "session_inspect"));
    const parent = writeSession("60.jsonl", "original", [
      abandoned, ok, branch, result("error-entry", branch.id, "error-call", true),
      result("orphan-result", branch.id, "orphan-call", false),
      assistant("unfittable-entry", branch.id, call("x".repeat(31_000), "unfittable_tool")),
      assistant("many-calls", branch.id, ...Array.from({ length: 47 }, (_, i) => call(`many-${i}`))),
    ]);
    writeSession("50.jsonl", "fork", [abandoned, ok,
      assistant("small-entry", ok.id, call("small", "unfittable_tool")),
    ], { parentSession: parent });
    writeSession("30.jsonl", "malformed", [abandoned, "{bad json"]);
    const oversized = join(project, "40.jsonl");
    writeFileSync(oversized, "");
    truncateSync(oversized, 128 * 1024 * 1024 + 1); // Sparse: exceed the input budget without writing 128 MiB.
    const oversizedDigest = await fileDigest(oversized);
    writeSession("20.jsonl", "legacy", [{ type: "message", message: {
      role: "assistant", content: [call("legacy-call")], timestamp,
    } }], { version: 1 });
    writeSession("70.jsonl", "other", [
      assistant("other-entry", null, call("other-call"), call("script-call", "codemode")),
      entry("script-result", "other-entry", {
        role: "toolResult", toolCallId: "script-call", toolName: "codemode", isError: false,
        content: [], timestamp,
        nestedCalls: {
          complete: false,
          calls: [
            { id: "script-call/1", name: "delegate_agent", status: "ok", arguments: { task: "nested task", token: secret } },
            { id: "script-call/2", name: "delegate_agent", status: "error", arguments: { task: "failed task" } },
            { id: "script-call/3", name: "delegate_agent", status: "unfinished", argumentsBytes: 12_000 },
            { id: "script-call/4", name: "continue_agent", status: "ok", arguments: { task: "continue work" } },
          ],
        },
      }),
    ], { cwd: otherCwd }, other);
    writeSession("12.jsonl", "former", [assistant("former-entry", null, call("former-call"))], { cwd: formerWorktree }, formerSessions);
    writeSession("11.jsonl", "backup", [assistant("backup-entry", null, call("backup-call"))], { cwd: similarlyNamed }, backupSessions);

    const ctx = { cwd, sessionManager: { getSessionDir: () => project } } as unknown as ExtensionContext;
    const definition = tool();
    const request = (options: Record<string, unknown> = {}) =>
      definition.execute("history", { action: "tools", history: "project", tool: "delegate_agent", ...options }, undefined, undefined, ctx);
    const query = async (options: Record<string, unknown> = {}) => output(await request(options));

    const first = await query({ sessionLimit: 1, limit: 50 });
    assert.equal(first.error, undefined);
    assert.deepEqual(first.coverage, {
      discovered: 5, attempted: 1, scanned: 1, failed: 0, matchingOccurrences: 50,
      returned: 50, scanComplete: false, examplesTruncated: false,
    });
    assert.ok(first.nextCursor);
    const byCall = (callId: string) => first.records.find((record: { callId: string }) => record.callId === callId);
    const copied = byCall("copied-call");
    assert.equal(copied.sessionId, "original");
    assert.equal(copied.sessionPath, realpathSync(parent));
    assert.equal(copied.parentSession, null);
    assert.equal(copied.entryId, "copied-entry");
    assert.equal(copied.resultEntryId, "ok-entry");
    assert.equal(copied.status, "ok");
    assert.equal(byCall("error-call").status, "error");
    assert.equal(byCall("error-call").resultEntryId, "error-entry");
    assert.equal(byCall("pending-call").status, "pending");
    assert.ok(first.records.every((record: object) => !Object.hasOwn(record, "arguments")));
    assert.doesNotMatch(JSON.stringify(first), /private-result-body/);

    const sampled = await query({ sessionLimit: 1, limit: 2 });
    assert.equal(sampled.coverage.matchingOccurrences, 50);
    assert.equal(sampled.coverage.returned, 2);
    assert.equal(sampled.coverage.examplesTruncated, true);
    assert.deepEqual(new Set(sampled.records.map((record: { callId: string }) => record.callId)), new Set(["many-45", "many-46"]));

    const limited = await query({ sessionLimit: 3, limit: 1 });
    assert.equal(limited.coverage.matchingOccurrences, 50, "example limit must not advance past an unrepresented fork");
    assert.equal(limited.records[0].sessionId, "original");
    assert.ok(limited.nextCursor);
    const limitedNext = await query({ cursor: limited.nextCursor, sessionLimit: 1, limit: 1 });
    assert.equal(limitedNext.records[0].sessionId, "fork");

    const largePage = await query({ tool: "large_tool", limit: 50 });
    assert.equal(largePage.coverage.attempted, 2);
    assert.equal(largePage.coverage.scanned, 1, "hard cap must not advance past an unrepresented fork");
    assert.equal(largePage.coverage.matchingOccurrences, 1);
    assert.deepEqual(largePage.records.map((record: { sessionId: string }) => record.sessionId), ["original"]);
    assert.ok(largePage.nextCursor);
    const largeNext = await query({ tool: "large_tool", cursor: largePage.nextCursor });
    assert.deepEqual(largeNext.records.map((record: { sessionId: string }) => record.sessionId), ["fork"]);

    const impossible = await query({ tool: "unfittable_tool", sessionLimit: 1 });
    assert.equal(impossible.coverage.scanned, 0);
    assert.equal(impossible.coverage.matchingOccurrences, 0);
    assert.equal(impossible.coverage.failed, 1);
    assert.match(JSON.stringify(impossible.failures), /no sampled example fits/);
    assert.ok(impossible.nextCursor);
    const afterImpossible = await query({ tool: "unfittable_tool", cursor: impossible.nextCursor, sessionLimit: 1 });
    assert.deepEqual(afterImpossible.records.map((record: { sessionId: string }) => record.sessionId), ["fork"]);

    const trimmedResult = await request({ sessionLimit: 3, limit: 50, maxChars: 2_000, includeArguments: true });
    const trimmed = output(trimmedResult);
    assert.ok((trimmedResult.content[0]?.text ?? "").length <= 30_000);
    assert.equal(trimmed.coverage.matchingOccurrences, 51);
    assert.equal(trimmed.coverage.failed, 1);
    assert.match(JSON.stringify(trimmed.failures), /session exceeds the 128 MiB scan budget/);
    assert.equal(trimmed.coverage.returned, trimmed.records.length);
    assert.ok(trimmed.records.length > 0 && trimmed.records.length < 50);
    assert.equal(trimmed.coverage.examplesTruncated, true);
    assert.equal(trimmed.coverage.scanComplete, false);
    assert.ok(trimmed.records.every((record: { arguments: string }) => record.arguments.length <= 2_000));
    assert.ok(trimmed.records.every((record: { arguments: string }) => record.arguments.includes("[REDACTED_KEY]")));
    assert.ok(!JSON.stringify(trimmed).includes(secret));
    assert.doesNotMatch(JSON.stringify(trimmed), /private-result-body/);
    assert.ok(trimmed.nextCursor);
    assert.deepEqual(new Set(trimmed.records.map((record: { sessionId: string }) => record.sessionId)), new Set(["original", "fork"]));

    const second = await query({ cursor: first.nextCursor, sessionLimit: 2 });
    assert.deepEqual(second.coverage, {
      discovered: 5, attempted: 2, scanned: 1, failed: 1, matchingOccurrences: 1,
      returned: 1, scanComplete: false, examplesTruncated: false,
    });
    assert.equal(second.records[0].sessionId, "fork");
    assert.equal(second.records[0].parentSession, parent);
    assert.equal(second.records[0].entryId, copied.entryId);
    assert.equal(second.records[0].callId, copied.callId);
    assert.ok(second.nextCursor);
    assert.equal(trimmed.nextCursor, second.nextCursor);

    const third = await query({ cursor: second.nextCursor, sessionLimit: 2 });
    assert.deepEqual(third.coverage, {
      discovered: 5, attempted: 2, scanned: 1, failed: 1, matchingOccurrences: 1,
      returned: 1, scanComplete: false, examplesTruncated: false,
    });
    assert.equal(third.records[0].sessionId, "legacy");
    assert.equal(third.records[0].callId, "legacy-call");
    assert.match(JSON.stringify(third.failures), /malformed JSONL/);
    assert.ok(!third.nextCursor);

    assert.match((await query({ cursor: "not-a-cursor" })).error, /cursor/i);
    assert.match((await query({ cursor: first.nextCursor, tool: "different" })).error, /cursor/i);
    assert.match((await query({ session: "60.jsonl" })).error, /session/i);
    assert.match((await query({ scope: "branch" })).error, /scope/i);
    assert.match((await query({ tool: " " })).error, /tool/i);
    const all = await query({ history: "all-projects", sessionLimit: 1 });
    assert.equal(all.coverage.discovered, 8);
    assert.equal(all.coverage.matchingOccurrences, 4);
    assert.equal(all.records[0].sessionId, "other");

    const otherCtx = {
      cwd: otherCwd, sessionManager: { getSessionDir: () => other },
    } as unknown as ExtensionContext;
    const nested = output(await definition.execute("nested-history", {
      action: "tools", history: "project", tool: "delegate_agent", includeArguments: true,
    }, undefined, undefined, otherCtx));
    assert.equal(nested.coverage.matchingOccurrences, 4);
    assert.equal(nested.coverage.incompleteNestedResults, 1);
    assert.equal(nested.coverage.scanComplete, true, "complete file scan does not establish complete nested metadata");
    assert.deepEqual(nested.records.map((record: { status: string }) => record.status),
      ["pending", "ok", "error", "unfinished"]);
    const recordedNested = nested.records.filter((record: { source?: string }) => record.source === "nested");
    assert.equal(recordedNested.length, 3);
    assert.ok(recordedNested.every((record: { entryId: string; parentCallId: string }) =>
      record.entryId === "script-result" && record.parentCallId === "script-call"));
    assert.match(recordedNested[0].arguments, /REDACTED_KEY/);
    assert.equal(recordedNested[2].argumentsUnavailable, true);
    assert.equal(recordedNested[2].argumentsBytes, 12_000);
    assert.doesNotMatch(JSON.stringify(nested), /sk-fixture-example-not-a-real-key/);
    const continuation = output(await definition.execute("nested-continuation", {
      action: "tools", history: "project", tool: "continue_agent",
    }, undefined, undefined, otherCtx));
    assert.deepEqual(continuation.records.map((record: { callId: string }) => record.callId), ["script-call/4"]);
    assert.equal(continuation.coverage.incompleteNestedResults, 1);
    const filteredNested = await query({
      history: "all-projects", cwdPrefixes: [otherCwd], sessionLimit: 1,
    });
    assert.equal(filteredNested.coverage.matchingOccurrences, 4);

    const prefixes = [cwd, join(directory, ".herdr", "worktrees", "project")];
    const scoped = async (options: Record<string, unknown> = {}) =>
      query({ history: "all-projects", cwdPrefixes: prefixes, sessionLimit: 1, limit: 1, ...options });
    const matched = new Set<string>();
    let excluded = 0;
    let cursor: string | undefined;
    let firstScopedCursor: string | undefined;
    do {
      const page = await scoped({ cursor });
      assert.equal(page.error, undefined);
      excluded += page.coverage.excluded;
      for (const record of page.records) matched.add(record.sessionId);
      cursor = page.nextCursor;
      firstScopedCursor ??= cursor;
    } while (cursor);
    assert.deepEqual(matched, new Set(["original", "fork", "legacy", "former"]));
    assert.equal(excluded, 2, "out-of-scope session headers do not consume the in-scope page limit");
    assert.equal(existsSync(formerWorktree), false, "the matching historical checkout no longer exists");
    assert.match((await scoped({ cursor: firstScopedCursor, cwdPrefixes: [cwd] })).error, /cursor/i);
    assert.equal((await scoped({ cursor: firstScopedCursor, cwdPrefixes: [...prefixes].reverse() })).error, undefined);
    assert.match((await scoped({ cwdPrefixes: ["relative"] })).error, /absolute/i);
    assert.match((await query({ history: "project", cwdPrefixes: prefixes })).error, /all-projects/i);

    const empty = output(await definition.execute("history-empty", {
      action: "tools", history: "project", tool: "unrecorded",
    }, undefined, undefined, { cwd: otherCwd, sessionManager: { getSessionDir: () => other } } as unknown as ExtensionContext));
    assert.deepEqual(empty.coverage, {
      discovered: 1, attempted: 1, scanned: 1, failed: 0, matchingOccurrences: 0,
      returned: 0, scanComplete: true, examplesTruncated: false, incompleteNestedResults: 1,
    });

    for (const [path, original] of originals) assert.equal(readFileSync(path, "utf8"), original, path);
    assert.equal(await fileDigest(oversized), oversizedDigest);
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
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
