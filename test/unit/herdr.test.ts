import assert from "node:assert/strict";
import test from "node:test";
import {
  agentWorkspaceRank,
  isReadyStatus,
  parseAgentsJson,
  parseSessionsJson,
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
  };
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/work/project" }, ["/work/project"]), 0);
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/work/project/subdir" }, ["/work/project"]), 1);
  assert.equal(agentWorkspaceRank({ ...base, cwd: "/other" }, ["/work/project"]), 2);
});
