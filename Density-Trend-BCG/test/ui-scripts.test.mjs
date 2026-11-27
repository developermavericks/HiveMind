// The dashboard's page scripts are classic scripts that share ONE global scope: a name declared in two of them
// (const/let/class) stops the whole page with "Identifier ... has already been declared". Compile them together, in page order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const dir = new URL("../src/", import.meta.url);
test("ui: all dashboard scripts load together without a name declared twice", () => {
  const html = readFileSync(new URL("dashboard.html", dir), "utf8");
  const files = [...html.matchAll(/<script[^>]*src="\/ui\/([a-z]+\.js)/g)].map((m) => m[1]);
  assert.ok(files.length >= 5, "found the page scripts");
  const code = files.map((f) => readFileSync(new URL(`ui/${f}`, dir), "utf8")).join("\n;\n");
  assert.doesNotThrow(() => new vm.Script(code, { filename: "dashboard-scripts.js" }));
});
