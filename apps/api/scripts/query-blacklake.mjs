import { readFile } from "node:fs/promises";
import { BlacklakeClient } from "../src/blacklake-client.mjs";
import { loadBlacklakeConfig } from "../src/config.mjs";

const [path, payloadFile] = process.argv.slice(2);
if (!path || !/^\/api\/[a-zA-Z0-9_./-]+$/.test(path)) {
  fail("用法：npm run blacklake:query -- /api/... [请求体.json]\n请求路径必须以 /api/ 开头。");
}

const config = loadBlacklakeConfig(process.env);
if (config.mode !== "live") fail("请先在 .env 中设置 BLACKLAKE_MODE=live 并填写 OpenAPI 凭据。");

const payload = payloadFile ? JSON.parse(await readFile(payloadFile, "utf8")) : {};
const client = new BlacklakeClient(config);
const response = await client.request(path, payload);
process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
