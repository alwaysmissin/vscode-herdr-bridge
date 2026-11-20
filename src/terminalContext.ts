import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { PAYLOAD_BYTE_LIMIT } from "./contextPayload";

export type TerminalContextKind = "selection" | "lastCommand";

interface Clipboard {
  readText(): PromiseLike<string>;
  writeText(text: string): PromiseLike<void>;
}

const COPY_COMMANDS: Record<TerminalContextKind, readonly string[]> = {
  selection: ["workbench.action.terminal.copySelection"],
  lastCommand: [
    "workbench.action.terminal.copyLastCommandAndLastCommandOutput",
    "workbench.action.terminal.copyLastCommand",
  ],
};

export class TerminalClipboard {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly clipboard: Clipboard,
    private readonly execute: (command: string) => PromiseLike<unknown>,
  ) {}

  read(kind: TerminalContextKind, isCurrent: () => boolean): Promise<string | undefined> {
    const result = this.pending.then(() => this.capture(kind, isCurrent));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async capture(kind: TerminalContextKind, isCurrent: () => boolean): Promise<string | undefined> {
    if (!isCurrent()) {
      return undefined;
    }
    const { clipboard } = this;
    const original = await clipboard.readText();
    if (!isCurrent()) {
      return undefined;
    }

    const marker = `Herdr Bridge ${randomUUID()}`;
    let captured = marker;
    await clipboard.writeText(marker);
    try {
      for (const command of COPY_COMMANDS[kind]) {
        if (!isCurrent()) {
          return undefined;
        }
        await this.execute(command);
        captured = await clipboard.readText();
        if (captured !== marker) {
          return isCurrent() ? captured : undefined;
        }
      }
      return undefined;
    } finally {
      if (await clipboard.readText() === captured) {
        await clipboard.writeText(original);
      }
    }
  }
}

function cleanText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/./gs, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159)) ? character : "";
  });
}

function utf8Boundary(bytes: Buffer, offset: number): boolean {
  return offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function prefixEnd(bytes: Buffer, limit: number): number {
  let end = Math.min(bytes.length, limit);
  while (!utf8Boundary(bytes, end)) {
    end--;
  }
  return end;
}

export function buildTerminalPayload(
  name: string,
  kind: TerminalContextKind,
  text: string,
): string | undefined {
  const source = cleanText(text);
  if (source.trim() === "") {
    return undefined;
  }
  const nameBytes = Buffer.from(cleanText(name).replace(/\n/g, " ").trim());
  const terminal = nameBytes.toString("utf8", 0, prefixEnd(nameBytes, 256)) || "Terminal";
  const label = kind === "selection" ? "Selected text" : "Last command and output";
  const header = `Terminal: ${terminal}\nSource: ${label}\n\n`;
  const available = PAYLOAD_BYTE_LIMIT - Buffer.byteLength(header);
  const bytes = Buffer.from(source);
  if (bytes.length <= available) {
    return header + source;
  }

  const notice = "\n... <terminal text truncated> ...\n";
  const contentBudget = available - Buffer.byteLength(notice);
  const headBudget = Math.floor(contentBudget / 2);
  const end = prefixEnd(bytes, headBudget);
  let start = bytes.length - (contentBudget - headBudget);
  while (!utf8Boundary(bytes, start)) {
    start++;
  }
  return header + bytes.toString("utf8", 0, end) + notice + bytes.toString("utf8", start);
}
