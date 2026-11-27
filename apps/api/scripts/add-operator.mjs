import { loadConfig } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
import { normalizeName } from "../src/crypto.mjs";

const [nameInput, idInput] = process.argv.slice(2);
const name = normalizeName(nameInput);
const blacklakeOperatorId = Number(idInput);

if (!name || !Number.isSafeInteger(blacklakeOperatorId) || blacklakeOperatorId <= 0) {
  console.error("用法：npm run operator:add -- \"张师傅\" 31001");
  process.exit(1);
}

const config = loadConfig();
const store = new Store(config.databasePath, config);
try {
  const operator = store.upsertBlacklakeOperator({ name, blacklakeOperatorId });
  console.log(`已登记：${operator.name} → 黑湖人员 ${operator.blacklakeOperatorId}`);
} finally {
  store.close();
}
