import { createServer } from "node:http";
import { loadConfig } from "./config.mjs";
import { Store } from "./store.mjs";
import { BlacklakeClient } from "./blacklake-client.mjs";
import { createApp } from "./app.mjs";
import { loadProcessInferenceRules } from "./process-inference.mjs";
import { loadDispatchPredictionRules } from "./dispatch-prediction.mjs";
import { loadDefectReasons } from "./defect-reasons.mjs";
import { WechatClient } from "./wechat-client.mjs";
import {LeaderClockout,startClockoutScheduler} from './leader-clockout.mjs';
import {OvernightClockout,startOvernightClockoutScheduler} from './overnight-clockout.mjs';
import {BlacklakeSync} from './blacklake-sync.mjs';
import {assertSyncCanDisable} from './integration-jobs.mjs';
import {BlacklakeRequestBudget} from './blacklake-request-budget.mjs';

const config = loadConfig();
const store = new Store(config.databasePath, config);
if(!config.dataSync.enabled)assertSyncCanDisable(store.db);
const blacklake = new BlacklakeClient(config.blacklake);
const dataSync=config.dataSync.enabled?new BlacklakeSync({store,blacklake,...config.dataSync}):undefined;
if(config.blacklake.mode==='live')blacklake.requestBudget=new BlacklakeRequestBudget({...config.requestBudget,...(dataSync?{
  load:()=>{const row=store.db.prepare("SELECT data_json FROM blacklake_sync_snapshots WHERE kind='control' AND target='request-budget'").get(),prior=row?JSON.parse(row.data_json):{};return {...prior,cooldownUntil:Math.max(prior.cooldownUntil||0,dataSync.snapshot('control','rate-limit').data?.until||0)};},
  save:value=>{store.db.prepare("INSERT INTO blacklake_sync_snapshots(kind,target,data_json,fetched_at,complete) VALUES('control','request-budget',?,?,1) ON CONFLICT(kind,target) DO UPDATE SET data_json=excluded.data_json,fetched_at=excluded.fetched_at").run(JSON.stringify(value),Date.now());}}:{})});
store.recoverInterruptedReports();
const wechat = new WechatClient(config.wechat);
const processInferenceRules = await loadProcessInferenceRules(config.processInferenceRulesPath);
const dispatchPredictionRules = await loadDispatchPredictionRules(config.dispatchPredictionRulesPath);
const defectReasons = await loadDefectReasons(config.defectReasonsPath);
const app=createApp({ config, store, blacklake, wechat, processInferenceRules, dispatchPredictionRules, defectReasons,dataSync });
const server = createServer((req,res)=>['POST','PUT','PATCH','DELETE'].includes(req.method)?blacklake.withPriority(()=>app(req,res)):app(req,res));
dataSync?.start();
const leaderClockout=new LeaderClockout({store});
const stopClockoutScheduler=startClockoutScheduler(leaderClockout,{onError:error=>console.warn(JSON.stringify({event:'clockout_scheduler_failed',code:error.code||'CLOCKOUT_FAILED'}))});
const overnightClockout=config.overnightClockout.enabled?new OvernightClockout({store,leaderClockout,referencePolicy:config.overnightClockout.referencePolicy}):null;
const stopOvernightClockoutScheduler=startOvernightClockoutScheduler(overnightClockout,{onError:error=>console.warn(JSON.stringify({event:'overnight_clockout_failed',code:error.code||'OVERNIGHT_CLOCKOUT_FAILED'}))});
if (config.blacklake.mode === "live"&&!dataSync) {
  blacklake.listWorkOrderCatalog().catch((error) => {
    console.warn(JSON.stringify({ event: "sku_catalog_warmup_failed", code: error.code || "BLACKLAKE_UNAVAILABLE" }));
  });
}

server.listen(config.port, config.host, () => {
  console.log(`报工 API 已启动：http://${config.host}:${config.port}`);
  console.log(`黑湖模式：${config.blacklake.mode}`);
  console.log(`已启用人员工序判断规则：${Object.keys(processInferenceRules.staffRules).length} 条`);
  console.log(`已配置质检不良原因：${defectReasons.length} 项`);
});

function shutdown(signal) {
  stopClockoutScheduler();
  stopOvernightClockoutScheduler();
  console.log(`${signal}：正在停止服务`);
  server.close(async () => {
    await dataSync?.stop();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
