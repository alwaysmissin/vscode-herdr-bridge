import assert from "node:assert/strict";
import { test } from "node:test";
import { PAYLOAD_BYTE_LIMIT } from "../../src/contextPayload";
import { buildTerminalPayload, TerminalClipboard } from "../../src/terminalContext";

const selection = "workbench.action.terminal.copySelection";
const combined = "workbench.action.terminal.copyLastCommandAndLastCommandOutput";
const commandOnly = "workbench.action.terminal.copyLastCommand";

function fakeClipboard() {
  let value = "original";
  return {
    readText: async () => value,
    writeText: async (text: string) => { value = text; },
  };
}

test("labels terminal context and preserves indentation while stripping control sequences", () => {
  assert.equal(
    buildTerminalPayload("Shell\nOne", "selection", "\u001b[31m  error\u001b[0m\r\n\tline\u0000\u001b[200~"),
    "Terminal: Shell One\nSource: Selected text\n\n  error\n\tline",
  );
  assert.equal(
    buildTerminalPayload("Shell", "lastCommand", "npm test\nfailed"),
    "Terminal: Shell\nSource: Last command and output\n\nnpm test\nfailed",
  );
  assert.equal(buildTerminalPayload("Shell", "selection", "\u001b[31m\r\n\t"), undefined);
});

test("truncates oversized terminal text at UTF-8 boundaries and keeps both ends", () => {
  const payload = buildTerminalPayload("端".repeat(300), "selection", `START\n${"🧪".repeat(30_000)}\nEND`);
  assert.ok(payload);
  assert.ok(Buffer.byteLength(payload) <= PAYLOAD_BYTE_LIMIT);
  assert.match(payload, /Selected text\n\nSTART\n/);
  assert.match(payload, /<terminal text truncated>/);
  assert.ok(payload.endsWith("\nEND"));
  assert.ok(!payload.includes("�"));
});

test("uses the combined command when available and falls back for commands without output", async () => {
  const clipboard = fakeClipboard();
  let withOutput = true;
  const calls: string[] = [];
  const capture = new TerminalClipboard(clipboard, async (command) => {
    calls.push(command);
    if (command === combined && withOutput) {
      await clipboard.writeText("echo hi\nhi");
    } else if (command === commandOnly) {
      await clipboard.writeText("true");
    }
  });
  assert.equal(await capture.read("lastCommand", () => true), "echo hi\nhi");
  withOutput = false;
  assert.equal(await capture.read("lastCommand", () => true), "true");
  assert.deepEqual(calls, [combined, combined, commandOnly]);
  assert.equal(await clipboard.readText(), "original");
});

test("does not send previous clipboard contents when VS Code copies nothing", async () => {
  const clipboard = fakeClipboard();
  const capture = new TerminalClipboard(clipboard, async () => undefined);
  assert.equal(await capture.read("selection", () => true), undefined);
  assert.equal(await capture.read("lastCommand", () => true), undefined);
  assert.equal(await clipboard.readText(), "original");
});

test("discards text after a terminal switch and still restores the clipboard", async () => {
  const clipboard = fakeClipboard();
  let current = true;
  const capture = new TerminalClipboard(clipboard, async () => {
    current = false;
    await clipboard.writeText("wrong terminal");
  });
  assert.equal(await capture.read("selection", () => current), undefined);
  assert.equal(await clipboard.readText(), "original");
});

test("does not overwrite clipboard text changed after the copy was read", async () => {
  const clipboard = fakeClipboard();
  let reads = 0;
  const capture = new TerminalClipboard({
    writeText: clipboard.writeText,
    readText: async () => {
      if (++reads === 3) {
        await clipboard.writeText("externally changed");
      }
      return clipboard.readText();
    },
  }, async () => clipboard.writeText("selection"));
  assert.equal(await capture.read("selection", () => true), "selection");
  assert.equal(await clipboard.readText(), "externally changed");
});

test("serializes copies and restores the clipboard when a command rejects", async () => {
  const clipboard = fakeClipboard();
  const calls: string[] = [];
  const capture = new TerminalClipboard(clipboard, async (command) => {
    calls.push(command);
    if (command === selection) {
      throw new Error("copy failed");
    }
    await clipboard.writeText("echo hi\nhi");
  });
  const failed = capture.read("selection", () => true);
  const succeeded = capture.read("lastCommand", () => true);
  await assert.rejects(failed, /copy failed/);
  assert.equal(await succeeded, "echo hi\nhi");
  assert.deepEqual(calls, [selection, combined]);
  assert.equal(await clipboard.readText(), "original");
});
