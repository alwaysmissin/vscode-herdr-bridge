import assert from "node:assert/strict";
import test from "node:test";
import { selectResources } from "../../src/selection";

interface FakeResource {
  fsPath: string;
  toString(): string;
}

function resource(fsPath: string): FakeResource {
  return { fsPath, toString: () => `file://${fsPath}` };
}

test("selectResources prefers the Explorer selection, de-duplicates, and sorts it", () => {
  const clicked = resource("/work/b.ts");
  const selected = [
    resource("/work/c.ts"),
    resource("/work/a.ts"),
    clicked,
    resource("/work/b.ts"),
  ];
  assert.deepEqual(
    selectResources(clicked, selected).map((entry) => entry.fsPath),
    ["/work/a.ts", "/work/b.ts", "/work/c.ts"],
  );
});

test("selectResources falls back to the clicked resource", () => {
  const clicked = resource("/work/b.ts");
  assert.deepEqual(
    selectResources(clicked, []).map((entry) => entry.fsPath),
    ["/work/b.ts"],
  );
  assert.deepEqual(
    selectResources(clicked, undefined).map((entry) => entry.fsPath),
    ["/work/b.ts"],
  );
});

test("selectResources returns nothing when no resource was passed", () => {
  assert.deepEqual(selectResources<FakeResource>(undefined, undefined), []);
});
