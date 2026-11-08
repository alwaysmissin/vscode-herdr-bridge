import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildPayload,
  type ContextBlock,
  PayloadTooLargeError,
  relativeDisplayPath,
  type WorkspaceRoot,
} from "./contextPayload";
import {
  HerdrClient,
  HerdrCommandError,
  isReadyStatus,
  sortAgentsForPicker,
} from "./herdr";
import { selectResources } from "./selection";
import type { AgentBinding, HerdrAgent } from "./types";

const BINDING_KEY = "herdrBridge.targetAgent";

interface AgentQuickPickItem extends vscode.QuickPickItem {
  agent: HerdrAgent;
}

interface SymbolCandidate {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
}

class HerdrBridge implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("Herdr Bridge");
  private readonly status = vscode.window.createStatusBarItem(
    "herdrBridge.target",
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly disposables: vscode.Disposable[] = [this.output, this.status];
  private client: HerdrClient;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.client = this.createClient();
    this.status.command = "herdrBridge.selectAgent";
    this.status.tooltip = "Select the Herdr agent that receives VS Code context";
    this.updateStatus();
    this.status.show();

    this.register("herdrBridge.sendContext", (uri?: vscode.Uri) => this.sendEditorContext(uri));
    this.register("herdrBridge.sendRelativePath", (uri?: vscode.Uri, selection?: vscode.Uri[]) =>
      this.sendPaths(uri, selection, "relative"));
    this.register("herdrBridge.sendAbsolutePath", (uri?: vscode.Uri, selection?: vscode.Uri[]) =>
      this.sendPaths(uri, selection, "absolute"));
    this.register("herdrBridge.selectAgent", () => this.selectAgent());
    this.register("herdrBridge.refreshAgents", () => this.refreshAgents());
    this.register("herdrBridge.showOutput", () => this.output.show());
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("herdrBridge")) {
          this.client = this.createClient();
          this.log("Configuration changed; Herdr client reset.");
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private register(command: string, handler: (...args: any[]) => unknown): void {
    this.disposables.push(vscode.commands.registerCommand(command, handler));
  }

  private createClient(): HerdrClient {
    const config = vscode.workspace.getConfiguration("herdrBridge");
    return new HerdrClient({
      configuredBinPath: config.get<string>("binPath", ""),
      timeoutMs: config.get<number>("commandTimeoutMs", 10000),
      log: (message) => this.log(message),
    });
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private binding(): AgentBinding | undefined {
    const value = this.context.workspaceState.get<AgentBinding>(BINDING_KEY);
    return value && typeof value.sessionName === "string" && typeof value.paneId === "string"
      ? value
      : undefined;
  }

  private async saveBinding(binding: AgentBinding | undefined): Promise<void> {
    await this.context.workspaceState.update(BINDING_KEY, binding);
    this.updateStatus();
  }

  private updateStatus(): void {
    const binding = this.binding();
    if (!binding) {
      this.status.text = "$(hubot) Herdr: Select Agent";
      this.status.tooltip = "No Herdr agent is bound to this workspace";
      return;
    }
    const session = binding.sessionName === "default" ? "" : ` @ ${binding.sessionName}`;
    const label = binding.cachedLabel.length > 36
      ? `${binding.cachedLabel.slice(0, 35)}…`
      : binding.cachedLabel;
    this.status.text = `$(hubot) Herdr: ${label}${session}`;
    this.status.tooltip = `${binding.cachedLabel}\n${binding.sessionName} · ${binding.paneId}${binding.cwd ? `\n${binding.cwd}` : ""}`;
  }

  private workspaceRoots(): WorkspaceRoot[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      fsPath: folder.uri.fsPath,
    }));
  }

  private pathForDocument(uri: vscode.Uri): string {
    if (uri.scheme === "untitled") {
      return `Untitled: ${path.basename(uri.path) || "Untitled"}`;
    }
    const relative = relativeDisplayPath(uri.fsPath, this.workspaceRoots());
    return relative ?? uri.fsPath;
  }

  private activeUri(uri?: vscode.Uri): vscode.Uri | undefined {
    if (uri instanceof vscode.Uri) {
      return uri;
    }
    return vscode.window.activeTextEditor?.document.uri;
  }

  private activeEditorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.uri.toString() === uri.toString() ? editor : undefined;
  }

  private async sendEditorContext(uriArg?: vscode.Uri): Promise<void> {
    try {
      const uri = this.activeUri(uriArg);
      if (!uri) {
        void vscode.window.showWarningMessage("Herdr: no active editor resource.");
        return;
      }
      const editor = this.activeEditorFor(uri);
      if (!editor) {
        void vscode.window.showWarningMessage("Herdr: open the file before sending editor context.");
        return;
      }

      const selections = editor.selections
        .filter((selection) => !selection.isEmpty)
        .sort((left, right) => left.start.compareTo(right.start));
      if (selections.length > 0) {
        const blocks = selections.map((selection) => this.blockForSelection(editor.document, selection));
        await this.deliver(buildPayload(blocks));
        return;
      }

      const symbol = await this.innermostSymbol(editor.document, editor.selection.active);
      if (symbol) {
        const block = this.blockForSymbol(editor.document, symbol);
        await this.deliver(buildPayload([block]));
        return;
      }

      if (uri.scheme !== "file") {
        void vscode.window.showWarningMessage("Herdr: select text in this untitled document first.");
        return;
      }
      await this.sendPaths(uri, undefined, "relative");
    } catch (error) {
      this.handleError(error);
    }
  }

  private blockForSelection(document: vscode.TextDocument, selection: vscode.Selection): ContextBlock {
    let endLine = selection.end.line;
    if (selection.end.character === 0 && selection.end.line > selection.start.line) {
      endLine -= 1;
    }
    return {
      path: this.pathForDocument(document.uri),
      startLine: selection.start.line + 1,
      endLine: endLine + 1,
      source: document.getText(selection),
    };
  }

  private blockForSymbol(document: vscode.TextDocument, symbol: SymbolCandidate): ContextBlock {
    let endLine = symbol.range.end.line;
    if (symbol.range.end.character === 0 && symbol.range.end.line > symbol.range.start.line) {
      endLine -= 1;
    }
    return {
      path: this.pathForDocument(document.uri),
      startLine: symbol.range.start.line + 1,
      endLine: endLine + 1,
      symbolKind: vscode.SymbolKind[symbol.kind],
      symbolName: symbol.name,
      source: document.getText(symbol.range),
    };
  }

  private async innermostSymbol(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<SymbolCandidate | undefined> {
    const symbols = await vscode.commands.executeCommand<(
      vscode.DocumentSymbol | vscode.SymbolInformation
    )[]>("vscode.executeDocumentSymbolProvider", document.uri);
    if (!symbols) {
      return undefined;
    }
    const candidates: SymbolCandidate[] = [];
    const visit = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation): void => {
      if ("location" in symbol) {
        if (symbol.location.uri.toString() === document.uri.toString()) {
          candidates.push({ name: symbol.name, kind: symbol.kind, range: symbol.location.range });
        }
        return;
      }
      candidates.push({ name: symbol.name, kind: symbol.kind, range: symbol.range });
      for (const child of symbol.children) {
        visit(child);
      }
    };
    for (const symbol of symbols) {
      visit(symbol);
    }
    return candidates
      .filter((candidate) => candidate.range.contains(position))
      .sort((left, right) => {
        const leftSize = document.offsetAt(left.range.end) - document.offsetAt(left.range.start);
        const rightSize = document.offsetAt(right.range.end) - document.offsetAt(right.range.start);
        return leftSize - rightSize;
      })[0];
  }

  private async isDirectory(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch (error) {
      this.log(`Could not inspect ${uri.fsPath}: ${String(error)}`);
      return false;
    }
  }

  private pathText(uri: vscode.Uri, mode: "relative" | "absolute"): string | undefined {
    return mode === "absolute"
      ? uri.fsPath
      : relativeDisplayPath(uri.fsPath, this.workspaceRoots());
  }

  private async sendPaths(
    uriArg: vscode.Uri | undefined,
    selectionArg: vscode.Uri[] | undefined,
    mode: "relative" | "absolute",
  ): Promise<void> {
    try {
      const active = vscode.window.activeTextEditor?.document.uri;
      const selected = selectResources(uriArg, selectionArg);
      const resources = selected.length > 0 ? selected : active ? [active] : [];
      if (resources.length === 0) {
        void vscode.window.showWarningMessage("Herdr: no file or folder is selected.");
        return;
      }
      if (resources.some((uri) => uri.scheme !== "file")) {
        void vscode.window.showWarningMessage(
          "Herdr: this command requires files or folders on disk.",
        );
        return;
      }

      const inspected = await Promise.all(resources.map(async (uri) => ({
        uri,
        text: this.pathText(uri, mode),
        directory: await this.isDirectory(uri),
      })));

      const entries: { uri: vscode.Uri; text: string; directory: boolean }[] = [];
      let outsideCount = 0;
      for (const entry of inspected) {
        if (entry.text === undefined) {
          outsideCount += 1;
        } else {
          entries.push({ uri: entry.uri, text: entry.text, directory: entry.directory });
        }
      }
      if (outsideCount > 0) {
        void vscode.window.showWarningMessage(
          outsideCount === 1
            ? "Herdr: the selected item is outside every workspace folder. Use Send Absolute Path instead."
            : `Herdr: ${outsideCount} selected items are outside every workspace folder. Use Send Absolute Path instead.`,
        );
        return;
      }

      const dirty = new Set(
        entries
          .filter((entry) => vscode.workspace.textDocuments.some(
            (document) => document.uri.toString() === entry.uri.toString() && document.isDirty,
          ))
          .map((entry) => entry.uri.toString()),
      );
      let note: string | undefined;
      if (dirty.size > 0) {
        const send = "Send Saved Version";
        const choice = await vscode.window.showWarningMessage(
          dirty.size === 1
            ? "This file has unsaved changes. The agent can only read the saved version from this path."
            : `${dirty.size} selected files have unsaved changes. The agent can only read the saved versions from these paths.`,
          { modal: true },
          send,
        );
        if (choice !== send) {
          return;
        }
        note = "This file has unsaved changes; the path refers to the saved version on disk.";
      }

      const blocks: ContextBlock[] = entries.map((entry) => ({
        path: entry.text,
        directory: entry.directory,
        note: dirty.has(entry.uri.toString()) ? note : undefined,
      }));
      await this.deliver(buildPayload(blocks));
    } catch (error) {
      this.handleError(error);
    }
  }

  private bindingFor(agent: HerdrAgent): AgentBinding {
    return {
      sessionName: agent.sessionName,
      paneId: agent.paneId,
      cachedLabel: this.agentLabel(agent),
      agentKind: agent.kind,
      cwd: agent.foregroundCwd ?? agent.cwd,
    };
  }

  private agentLabel(agent: HerdrAgent): string {
    const parts = [agent.name ?? agent.displayName];
    if (agent.name && agent.name !== agent.kind) {
      parts.push(agent.kind);
    }
    if (agent.conversationTitle && !parts.includes(agent.conversationTitle)) {
      parts.push(agent.conversationTitle);
    }
    return parts.join(" · ");
  }

  private sortedAgents(agents: readonly HerdrAgent[]): HerdrAgent[] {
    const roots = this.workspaceRoots().map((root) => root.fsPath);
    return sortAgentsForPicker(agents, roots);
  }

  private async pickAgent(agents?: readonly HerdrAgent[]): Promise<AgentBinding | undefined> {
    const available = this.sortedAgents(agents ?? await this.client.discoverAgents());
    if (available.length === 0) {
      void vscode.window.showWarningMessage("Herdr: no agents are running in any local session.");
      return undefined;
    }
    const items: AgentQuickPickItem[] = available.map((agent) => {
      const label = this.agentLabel(agent);
      return {
        label: `$(hubot) ${label}`,
        description: `${agent.status} · ${agent.sessionName} · ${agent.paneId}`,
        detail: agent.foregroundCwd ?? agent.cwd ?? "Working directory unavailable",
        agent,
      };
    });
    const selected = await vscode.window.showQuickPick(items, {
      title: "Select Herdr Agent",
      placeHolder: "All local running Herdr sessions are included",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) {
      return undefined;
    }
    const binding = this.bindingFor(selected.agent);
    await this.saveBinding(binding);
    return binding;
  }

  private async selectAgent(): Promise<void> {
    try {
      await this.pickAgent();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async refreshAgents(): Promise<void> {
    try {
      const agents = await this.client.discoverAgents();
      const binding = this.binding();
      if (binding) {
        const live = agents.find(
          (agent) => agent.sessionName === binding.sessionName && agent.paneId === binding.paneId,
        );
        if (live) {
          await this.saveBinding(this.bindingFor(live));
        }
      }
      void vscode.window.showInformationMessage(
        `Herdr: found ${agents.length} running agent${agents.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      this.handleError(error);
    }
  }

  private async readyTarget(): Promise<{ binding: AgentBinding; agent: HerdrAgent } | undefined> {
    const agents = await this.client.discoverAgents();
    let binding = this.binding();
    let agent = binding
      ? agents.find((candidate) =>
          candidate.sessionName === binding?.sessionName && candidate.paneId === binding.paneId)
      : undefined;

    if (!agent) {
      if (binding) {
        await this.saveBinding(undefined);
        void vscode.window.showWarningMessage("Herdr: the bound agent is no longer running. Select another agent.");
      }
      binding = await this.pickAgent(agents);
      agent = binding
        ? agents.find((candidate) =>
            candidate.sessionName === binding?.sessionName && candidate.paneId === binding.paneId)
        : undefined;
    }
    if (!binding || !agent) {
      return undefined;
    }

    if (!isReadyStatus(agent.status)) {
      const select = "Select Agent";
      const choice = await vscode.window.showWarningMessage(
        `Herdr: ${agent.displayName} is ${agent.status}; context is only pasted to idle or done agents.`,
        select,
      );
      if (choice !== select) {
        return undefined;
      }
      binding = await this.pickAgent(agents);
      agent = binding
        ? agents.find((candidate) =>
            candidate.sessionName === binding?.sessionName && candidate.paneId === binding.paneId)
        : undefined;
      if (!binding || !agent || !isReadyStatus(agent.status)) {
        if (agent) {
          void vscode.window.showWarningMessage(`Herdr: ${agent.displayName} is ${agent.status}; nothing was pasted.`);
        }
        return undefined;
      }
    }

    const refreshed = this.bindingFor(agent);
    await this.saveBinding(refreshed);
    return { binding: refreshed, agent };
  }

  private async deliver(payload: string, retryStale = true): Promise<void> {
    const target = await this.readyTarget();
    if (!target) {
      return;
    }
    try {
      await this.client.sendText(target.binding, payload);
    } catch (error) {
      if (
        retryStale && error instanceof HerdrCommandError &&
        ["agent_not_found", "pane_not_found", "workspace_not_found"].includes(error.code)
      ) {
        await this.saveBinding(undefined);
        this.log(`Target became stale during send: ${error.code}`);
        await this.deliver(payload, false);
        return;
      }
      throw error;
    }

    try {
      await this.client.focusAgent(target.binding);
      void vscode.window.showInformationMessage(`Herdr: pasted context to ${target.agent.displayName}.`);
    } catch (error) {
      this.log(`Context was pasted, but focus failed: ${String(error)}`);
      void vscode.window.showWarningMessage(
        `Herdr: context was pasted to ${target.agent.displayName}, but its pane could not be focused.`,
      );
    }
  }

  private handleError(error: unknown): void {
    if (error instanceof PayloadTooLargeError) {
      void vscode.window.showErrorMessage(
        "Herdr: the context references still exceed 64 KiB. Select fewer files or ranges.",
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.log(`Error: ${message}`);
    const showOutput = "Show Output";
    void vscode.window.showErrorMessage(`Herdr: ${message}`, showOutput).then((choice) => {
      if (choice === showOutput) {
        this.output.show();
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new HerdrBridge(context));
}

export function deactivate(): void {}
