export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrSession {
  name: string;
  default: boolean;
  running: boolean;
  sessionDir?: string;
  socketPath?: string;
}

export interface HerdrAgent {
  sessionName: string;
  paneId: string;
  kind: string;
  name?: string;
  displayName: string;
  conversationTitle?: string;
  status: AgentStatus;
  cwd?: string;
  foregroundCwd?: string;
  workspaceId?: string;
  tabId?: string;
}

export interface AgentBinding {
  sessionName: string;
  paneId: string;
  cachedLabel: string;
  agentKind?: string;
  cwd?: string;
}
