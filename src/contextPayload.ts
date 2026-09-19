import * as path from "node:path";

export const FULL_SOURCE_LINE_LIMIT = 12;
export const EDGE_SOURCE_LINES = 3;
export const PAYLOAD_BYTE_LIMIT = 64 * 1024;

export interface WorkspaceRoot {
  name: string;
  fsPath: string;
}

export interface ContextBlock {
  path: string;
  startLine?: number;
  endLine?: number;
  symbolKind?: string;
  symbolName?: string;
  source?: string;
  note?: string;
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("The context references exceed the 64 KiB Herdr payload limit.");
    this.name = "PayloadTooLargeError";
  }
}

function normalizedLines(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function summarizeSource(source: string): string[] {
  const lines = normalizedLines(source);
  if (lines.length <= FULL_SOURCE_LINE_LIMIT) {
    return lines;
  }

  const omitted = lines.length - EDGE_SOURCE_LINES * 2;
  return [
    ...lines.slice(0, EDGE_SOURCE_LINES),
    `... <${omitted} lines omitted> ...`,
    ...lines.slice(-EDGE_SOURCE_LINES),
  ];
}

function renderBlock(block: ContextBlock, includeSource: boolean): string {
  const lines = [`File: ${block.path}`];
  if (block.symbolName) {
    const kind = block.symbolKind ? `${block.symbolKind} ` : "";
    lines.push(`Symbol: ${kind}${block.symbolName}`);
  }
  if (block.startLine !== undefined) {
    const end = block.endLine ?? block.startLine;
    lines.push(`Lines: ${block.startLine}${end === block.startLine ? "" : `-${end}`}`);
  }
  if (block.note) {
    lines.push(`Note: ${block.note}`);
  }
  if (includeSource && block.source !== undefined) {
    lines.push("Source:");
    for (const sourceLine of summarizeSource(block.source)) {
      lines.push(`    ${sourceLine}`);
    }
  }
  return lines.join("\n");
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function buildPayload(blocks: readonly ContextBlock[]): string {
  const withSource = blocks.map((block) => renderBlock(block, true)).join("\n\n");
  if (byteLength(withSource) <= PAYLOAD_BYTE_LIMIT) {
    return withSource;
  }

  const withoutSource = [
    "Note: Source summaries were omitted because the context exceeded 64 KiB.",
    "",
    blocks.map((block) => renderBlock(block, false)).join("\n\n"),
  ].join("\n");
  if (byteLength(withoutSource) <= PAYLOAD_BYTE_LIMIT) {
    return withoutSource;
  }
  throw new PayloadTooLargeError();
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function relativeDisplayPath(
  filePath: string,
  roots: readonly WorkspaceRoot[],
): string | undefined {
  const matches = roots
    .filter((root) => isInside(filePath, root.fsPath))
    .sort((left, right) => right.fsPath.length - left.fsPath.length);
  const root = matches[0];
  if (!root) {
    return undefined;
  }
  const relative = path.relative(root.fsPath, filePath).split(path.sep).join("/");
  return roots.length > 1 ? `${root.name}/${relative}` : relative;
}
