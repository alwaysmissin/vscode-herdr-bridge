import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentBinding, AgentStatus, HerdrAgent, HerdrSession } from "./types";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export interface HerdrClientOptions {
  configuredBinPath: string;
  timeoutMs: number;
  log: (message: string) => void;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

export class HerdrCommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode?: number | string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

function parseJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new HerdrCommandError(`${description} returned invalid JSON.`, "invalid_json");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeStatus(value: unknown): AgentStatus {
  switch (value) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return value;
    default:
      return "unknown";
  }
}

function conversationTitle(item: Record<string, unknown>, cwd: string | undefined): string | undefined {
  let title = stringValue(item.terminal_title_stripped);
  if (!title) {
    return undefined;
  }
  if (cwd) {
    const directoryName = path.basename(cwd);
    const suffix = ` | ${directoryName}`;
    if (directoryName && title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length).trimEnd();
    }
  }
  return title || undefined;
}

export function parseSessionsJson(stdout: string): HerdrSession[] {
  const root = record(parseJson(stdout, "herdr session list"));
  const sessions = root?.sessions;
  if (!Array.isArray(sessions)) {
    throw new HerdrCommandError("herdr session list is missing sessions.", "invalid_json");
  }
  return sessions.flatMap((value): HerdrSession[] => {
    const item = record(value);
    const name = stringValue(item?.name);
    if (!item || !name) {
      return [];
    }
    return [{
      name,
      default: booleanValue(item.default) ?? name === "default",
      running: booleanValue(item.running) ?? false,
      sessionDir: stringValue(item.session_dir),
      socketPath: stringValue(item.socket_path),
    }];
  });
}

export function parseAgentsJson(stdout: string, sessionName: string): HerdrAgent[] {
  const root = record(parseJson(stdout, "herdr agent list"));
  const result = record(root?.result);
  const agents = result?.agents;
  if (!Array.isArray(agents)) {
    throw new HerdrCommandError("herdr agent list is missing result.agents.", "invalid_json");
  }
  return agents.flatMap((value): HerdrAgent[] => {
    const item = record(value);
    const paneId = stringValue(item?.pane_id);
    const kind = stringValue(item?.agent);
    if (!item || !paneId || !kind) {
      return [];
    }
    const name = stringValue(item.name);
    const cwd = stringValue(item.foreground_cwd) ?? stringValue(item.cwd);
    const displayName = name ?? stringValue(item.display_agent) ?? kind;
    return [{
      sessionName,
      paneId,
      kind,
      name,
      displayName,
      conversationTitle: conversationTitle(item, cwd),
      status: normalizeStatus(item.agent_status),
      cwd: stringValue(item.cwd),
      foregroundCwd: stringValue(item.foreground_cwd),
      workspaceId: stringValue(item.workspace_id),
      tabId: stringValue(item.tab_id),
    }];
  });
}

function parseCommandError(error: ExecError): HerdrCommandError {
  const stderr = error.stderr?.trim() ?? "";
  if (stderr) {
    try {
      const parsed = record(JSON.parse(stderr));
      const detail = record(parsed?.error);
      const code = stringValue(detail?.code) ?? "herdr_error";
      const message = stringValue(detail?.message) ?? stderr;
      return new HerdrCommandError(message, code, error.code);
    } catch {
      return new HerdrCommandError(stderr, "herdr_error", error.code);
    }
  }
  if (error.code === "ENOENT") {
    return new HerdrCommandError("The herdr executable was not found.", "binary_not_found", error.code);
  }
  if (error.killed) {
    return new HerdrCommandError("The herdr command timed out.", "timeout", error.code);
  }
  return new HerdrCommandError(error.message, "process_error", error.code);
}

function execute(file: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const withOutput = error as ExecError;
          withOutput.stdout = stdout;
          withOutput.stderr = stderr;
          reject(parseCommandError(withOutput));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  return value.startsWith(`~${path.sep}`) ? path.join(os.homedir(), value.slice(2)) : value;
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary(configured: string): Promise<string> {
  if (configured.trim()) {
    const candidate = expandHome(configured.trim());
    if (!candidate.includes(path.sep) || await executable(candidate)) {
      return candidate;
    }
    throw new HerdrCommandError(`Configured herdr executable is not accessible: ${candidate}`, "binary_not_found");
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "herdr");
    if (await executable(candidate)) {
      return candidate;
    }
  }
  for (const candidate of [
    path.join(os.homedir(), ".local", "bin", "herdr"),
    path.join(os.homedir(), ".cargo", "bin", "herdr"),
    "/usr/local/bin/herdr",
    "/usr/bin/herdr",
  ]) {
    if (await executable(candidate)) {
      return candidate;
    }
  }
  throw new HerdrCommandError(
    "The herdr executable was not found. Set herdrBridge.binPath in VS Code settings.",
    "binary_not_found",
  );
}

export function wrapBracketedPaste(text: string): string {
  const sanitized = text
    .replaceAll(BRACKETED_PASTE_START, "")
    .replaceAll(BRACKETED_PASTE_END, "");
  return `${BRACKETED_PASTE_START}${sanitized}\n${BRACKETED_PASTE_END}`;
}

export function isReadyStatus(status: AgentStatus): boolean {
  return status === "idle" || status === "done";
}

function normalizedPath(value: string): string {
  return path.resolve(value);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function agentWorkspaceRank(agent: HerdrAgent, workspaceRoots: readonly string[]): number {
  const cwd = agent.foregroundCwd ?? agent.cwd;
  if (!cwd || workspaceRoots.length === 0) {
    return 2;
  }
  const agentPath = normalizedPath(cwd);
  const roots = workspaceRoots.map(normalizedPath);
  if (roots.some((root) => root === agentPath)) {
    return 0;
  }
  return roots.some((root) => contains(root, agentPath) || contains(agentPath, root)) ? 1 : 2;
}

export class HerdrClient {
  private binaryPromise: Promise<string> | undefined;

  constructor(private readonly options: HerdrClientOptions) {}

  invalidateBinary(): void {
    this.binaryPromise = undefined;
  }

  private binary(): Promise<string> {
    this.binaryPromise ??= resolveBinary(this.options.configuredBinPath);
    return this.binaryPromise;
  }

  private async run(args: readonly string[], payloadIndex?: number): Promise<CommandResult> {
    const binary = await this.binary();
    const printable = args.map((value, index) =>
      index === payloadIndex ? `<payload ${Buffer.byteLength(value, "utf8")} bytes>` : value,
    );
    this.options.log(`$ ${binary} ${printable.join(" ")}`);
    return execute(binary, args, this.options.timeoutMs);
  }

  async listSessions(): Promise<HerdrSession[]> {
    const result = await this.run(["session", "list", "--json"]);
    return parseSessionsJson(result.stdout);
  }

  async listAgents(sessionName: string): Promise<HerdrAgent[]> {
    const result = await this.run(["--session", sessionName, "agent", "list"]);
    return parseAgentsJson(result.stdout, sessionName);
  }

  async discoverAgents(): Promise<HerdrAgent[]> {
    const sessions = (await this.listSessions()).filter((session) => session.running);
    if (sessions.length === 0) {
      return [];
    }
    const results = await Promise.allSettled(
      sessions.map((session) => this.listAgents(session.name)),
    );
    const agents: HerdrAgent[] = [];
    let firstFailure: unknown;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        agents.push(...result.value);
      } else {
        firstFailure ??= result.reason;
        this.options.log(`Failed to list session ${sessions[index].name}: ${String(result.reason)}`);
      }
    }
    if (results.every((result) => result.status === "rejected") && firstFailure) {
      throw firstFailure;
    }
    return agents;
  }

  async sendText(binding: AgentBinding, payload: string): Promise<void> {
    const wrapped = wrapBracketedPaste(payload);
    await this.run(
      ["--session", binding.sessionName, "pane", "send-text", binding.paneId, wrapped],
      5,
    );
  }

  async focusAgent(binding: AgentBinding): Promise<void> {
    await this.run(["--session", binding.sessionName, "agent", "focus", binding.paneId]);
  }
}
