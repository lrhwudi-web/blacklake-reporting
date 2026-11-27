import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptPath = new URL("../pages/login/login.js", import.meta.url);
const markupPath = new URL("../pages/login/login.wxml", import.meta.url);

test("登录使用微信一次绑定，不申请或输入手机号", async () => {
  const [script, markup] = await Promise.all([
    readFile(scriptPath, "utf8"),
    readFile(markupPath, "utf8")
  ]);

  assert.match(script, /wx\.login/);
  assert.match(script, /\/v1\/auth\/wechat/);
  assert.match(script, /\/v1\/auth\/operators/);
  assert.match(script, /\/v1\/auth\/bind/);
  assert.match(script, /\/v1\/auth\/review/);
  assert.match(markup, /第一次，请选姓名/);
  assert.match(markup, /6位确认码/);
  assert.match(markup, /微信审核体验/);
  assert.match(markup, /提审备注中的审核码/);
  assert.doesNotMatch(`${script}\n${markup}`, /手机号|getPhoneNumber|auth\/login/);
});
