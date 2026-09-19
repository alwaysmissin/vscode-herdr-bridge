# Herdr Bridge

Herdr Bridge connects a VS Code workspace to an agent running in a local Herdr session. It sends file references and compact source context directly to the agent pane, without adding a task prompt or pressing Enter.

## Features

- Select the target agent from the VS Code status bar. The binding is stored per workspace.
- Show the current Claude or Codex conversation title reported by Herdr, such as `Read page tables`, in the agent picker and status bar.
- Discover agents in every running default or named Herdr session on the same host as the VS Code extension host.
- Send all nonempty editor selections. With no selection, send the innermost symbol under the cursor. With no symbol, send the current file path.
- Send a relative or absolute path from the Explorer and editor-tab context menus.
- Paste only to agents whose Herdr status is `idle` or `done`.
- Focus the target Herdr pane after a successful paste.
- Limit payloads to 64 KiB. Long selections include the first three and last three lines; oversized payloads fall back to references only.

## Install

Build a VSIX and install it from VS Code:

```bash
npm ci
npm run package
code --install-extension vscode-herdr-bridge.vsix
```

The extension runs where the workspace runs. For Remote SSH or WSL workspaces, Herdr must run in that same remote environment.

## Use

1. Start Herdr and at least one agent.
2. Open a VS Code workspace on the same host.
3. Click `Herdr: Select Agent` in the status bar and choose an agent.
4. Select source in an editor, or place the cursor inside a symbol, then choose **Herdr: Send Selection or Current Symbol** from the editor context menu.
5. For a file reference, open the **Herdr** submenu in the Explorer or editor-tab context menu and choose a relative or absolute path.

The extension wraps the payload in bracketed-paste markers and calls:

```text
herdr --session <session> pane send-text <pane-id> <payload>
herdr --session <session> agent focus <pane-id>
```

It does not submit the agent input. Review the pasted context in Herdr and press Enter when ready.

### Agent labels

Herdr Bridge automatically reads `terminal_title_stripped` from `herdr agent list`. The picker combines the agent kind and generated conversation title, for example `codex · Read page tables`. Codex's trailing ` | <working-directory>` suffix is removed when it matches the agent working directory.

If no generated title is available, the picker falls back to the custom agent name and then the agent kind.

You can also give an agent a fixed custom name with Herdr:

```bash
herdr agent rename w8:p1 kernel-notes
herdr agent rename w8:p5 vscode-plugin
```

When both a custom name and generated conversation title exist, the main label includes both. The agent kind, status, session, and pane ID remain in the description. Clear a name with `herdr agent rename <pane-id> --clear`.

## Commands

- `Herdr: Select Target Agent`
- `Herdr: Refresh Agents`
- `Herdr: Send Selection or Current Symbol`
- `Herdr: Send Relative Path`
- `Herdr: Send Absolute Path`
- `Herdr: Show Output`

## Settings

- `herdrBridge.binPath`: Optional path to the Herdr executable. When empty, the extension searches `PATH`, `~/.local/bin`, and `~/.cargo/bin`.
- `herdrBridge.commandTimeoutMs`: Timeout for each Herdr CLI command. The default is 10 seconds.

## Development

```bash
npm ci
npm run lint
npm test
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host, or run `npm run test:integration` for the activation smoke test.

## Release

GitHub Actions builds and tests every push and pull request. Successful runs attach `vscode-herdr-bridge.vsix` and its SHA-256 checksum as workflow artifacts for 14 days.

To publish a GitHub Release, update the version in `package.json` and `package-lock.json`, commit the change, then push a matching tag:

```bash
git tag v0.1.2
git push origin v0.1.2
```

The tag must equal `v` followed by the package version. After all checks pass, CI creates the release notes and uploads the VSIX and checksum automatically.

## License

MIT
