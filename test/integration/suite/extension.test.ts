import assert from "node:assert/strict";
import * as vscode from "vscode";

suite("Herdr Bridge", () => {
  test("activates and registers commands", async () => {
    const extension = vscode.extensions.getExtension("kinder.vscode-herdr-bridge");
    assert.ok(extension, "extension is installed in the test host");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("herdrBridge.selectAgent"));
    assert.ok(commands.includes("herdrBridge.sendContext"));
  });
});
