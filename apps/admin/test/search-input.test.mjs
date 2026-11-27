import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptPath = new URL("../app.js", import.meta.url);

test("人员姓名搜索只更新结果区域，不替换中文输入法正在使用的输入框", async () => {
  const script = await readFile(scriptPath, "utf8");
  const inputListener = script.match(/document\.addEventListener\("input", \(event\) => \{[\s\S]*?\n  \}\);/)?.[0] || "";
  const peopleRenderer = script.match(/function renderPeopleSearchResults\(\) \{[\s\S]*?\n  \}/)?.[0] || "";

  assert.match(inputListener, /stateKey === "peopleSearch"/);
  assert.match(inputListener, /renderPeopleSearchResults\(\);\s*return;/);
  assert.match(peopleRenderer, /#people-count/);
  assert.match(peopleRenderer, /#people-table/);
  assert.doesNotMatch(peopleRenderer, /\brender\(\)/);
});
