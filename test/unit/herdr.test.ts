import assert from "node:assert/strict";
import test from "node:test";
import {
  agentWorkspaceRank,
  isReadyStatus,
  parseAgentsJson,
  parseSessionsJson,
  sortAgentsForPicker,
  wrapBracketedPaste,
} from "../../src/herdr";

test("parseSessionsJson accepts named and default sessions", () => {
  const sessions = parseSessionsJson(JSON.stringify({ sessions: [
    { name: "default", default: true, running: true },
    { name: "kernel", running: false, socket_path: "/tmp/kernel.sock" },
  ] }));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].name, "kernel");
  assert.equal(sessions[1].socketPath, "/tmp/kernel.sock");
});

test("parseAgentsJson tolerates optional fields and normalizes unknown status", () => {
  const agents = parseAgentsJson(JSON.stringify({ result: { agents: [{
    agent: "codex",
    pane_id: "%7",
    agent_status: "starting",
    cwd: "/work/project",
  }] } }), "kernel");
  assert.deepEqual(agents[0], {
    sessionName: "kernel",
    paneId: "%7",
    kind: "codex",
    name: undefined,
    displayName: "codex",
    conversationTitle: undefined,
    status: "unknown",
    focused: false,
    cwd: "/work/project",
    foregroundCwd: undefined,
    workspaceId: undefined,
    tabId: undefined,
  });
});

test("parseAgentsJson prefers the custom agent name", () => {
  const [agent] = parseAgentsJson(JSON.stringify({ result: { agents: [{
    agent: "claude",
    pane_id: "w8:p1",
    agent_status: "idle",
    name: "kernel-notes",
    display_agent: "Claude Code",
    terminal_title_stripped: "Read page tables | project",
    foreground_cwd: "/work/project",
  }] } }), "default");
  assert.equal(agent.name, "kernel-notes");
  assert.equal(agent.displayName, "kernel-notes");
  assert.equal(agent.kind, "claude");
  assert.equal(agent.conversationTitle, "Read page tables");
});

test("parseAgentsJson reads Herdr's generated conversation title", () => {
  const [agent] = parseAgentsJson(JSON.stringify({ result: { agents: [{
    agent: "codex",
    pane_id: "w8:pS",
    agent_status: "working",
    cwd: "/home/kinder/Linux-Kernel-Learning",
    terminal_title_stripped: "简化 VS Code 向 herdr 发送代码 | Linux-Kernel-Learning",
  }] } }), "default");
  assert.equal(agent.conversationTitle, "简化 VS Code 向 herdr 发送代码");
});

test("parseAgentsJson reads the focused pane flag", () => {
  const agents = parseAgentsJson(JSON.stringify({ result: { agents: [
    { agent: "codex", pane_id: "w8:p1", agent_status: "idle", focused: true },
    { agent: "claude", pane_id: "w8:p2", agent_status: "idle" },
  ] } }), "default");
  assert.equal(agents[0].focused, true);
  assert.equal(agents[1].focused, false);
});

test("wrapBracketedPaste strips nested terminal markers", () => {
  const wrapped = wrapBracketedPaste(`before\u001b[200~inside\u001b[201~after`);
  assert.equal(wrapped, "\u001b[200~beforeinsideafter\n\u001b[201~");
});

test("wrapBracketedPaste ends the paste with a newline so consecutive inserts start on a fresh line", () => {
  assert.equal(wrapBracketedPaste("payload"), "\u001b[200~payload\n\u001b[201~");
});

test("only idle and done agents are ready", () => {
  assert.equal(isReadyStatus("idle"), true);
  assert.equal(isReadyStatus("done"), true);
  assert.equal(isReadyStatus("working"), false);
  assert.equal(isReadyStatus("blocked"), false);
  assert.equal(isReadyStatus("unknown"), false);
});

test("agentWorkspaceRank favors the current workspace", () => {
  const base = {
    sessionName: "default",
    paneId: "%1",
    kind: "codex",
    displayName: "codex",
    conversationTitle: undefined,
    status: "idle" as const,
    focused: false,
  };
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/work/project" }, ["/work/project"]), 0);
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/work/project/subdir" }, ["/work/project"]), 1);
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/other" }, ["/work/project"]), 2);
});

test("sortAgentsForPicker puts the focused agent first regardless of workspace", () => {
  const base = {
    sessionName: "default",
    kind: "codex",
    displayName: "codex",
    conversationTitle: undefined,
    status: "idle" as const,
  };
  const outside = { ...base, paneId: "w1:p1", cwd: "/other", focused: false };
  const matching = { ...base, paneId: "w1:p2", cwd: "/work/project", focused: false };
  const focused = { ...base, paneId: "w1:p3", cwd: "/other", focused: true };
  const sorted = sortAgentsForPicker([outside, matching, focused], ["/work/project"]);
  assert.deepEqual(sorted.map((agent) => agent.paneId), ["w1:p3", "w1:p2", "w1:p1"]);
});

test("sortAgentsForPicker breaks ties by session and pane id", () => {
  const base = {
    kind: "codex",
    displayName: "codex",
    conversationTitle: undefined,
    status: "idle" as const,
    focused: false,
  };
  const sorted = sortAgentsForPicker([
    { ...base, sessionName: "default", paneId: "w1:p2" },
    { ...base, sessionName: "default", paneId: "w1:p1" },
  ], []);
  assert.deepEqual(sorted.map((agent) => agent.paneId), ["w1:p1", "w1:p2"]);
});

