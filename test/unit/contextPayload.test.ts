import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPayload,
  PayloadTooLargeError,
  relativeDisplayPath,
  summarizeSource,
} from "../../src/contextPayload";

test("summarizeSource keeps selections up to twelve lines", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.deepEqual(summarizeSource(source), source.split("\n"));
});

test("summarizeSource keeps three lines from each edge", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.deepEqual(summarizeSource(source), [
    "line 1",
    "line 2",
    "line 3",
    "... <14 lines omitted> ...",
    "line 18",
    "line 19",
    "line 20",
  ]);
});

test("relativeDisplayPath prefixes the folder in a multi-root workspace", () => {
  const roots = [
    { name: "client", fsPath: "/work/client" },
    { name: "server", fsPath: "/work/server" },
  ];
  assert.equal(relativeDisplayPath("/work/server/src/app.ts", roots), "server/src/app.ts");
  assert.equal(relativeDisplayPath("/elsewhere/app.ts", roots), undefined);
});

test("buildPayload renders source locations and summaries", () => {
  const payload = buildPayload([{
    path: "src/app.ts",
    startLine: 4,
    endLine: 5,
    source: "const one = 1;\nconst two = 2;",
  }]);
  assert.match(payload, /File: src\/app\.ts/);
  assert.match(payload, /Lines: 4-5/);
  assert.match(payload, / {4}const one = 1;/);
});

test("buildPayload drops source summaries before rejecting an oversized payload", () => {
  const payload = buildPayload([{
    path: "src/huge.ts",
    source: `first\n${"x".repeat(70 * 1024)}\nlast`,
  }]);
  assert.match(payload, /Source summaries were omitted/);
  assert.match(payload, /File: src\/huge\.ts/);
  assert.doesNotMatch(payload, /x{100}/);
});

test("buildPayload rejects references that exceed 64 KiB", () => {
  assert.throws(
    () => buildPayload([{ path: "x".repeat(70 * 1024) }]),
    PayloadTooLargeError,
  );
});
