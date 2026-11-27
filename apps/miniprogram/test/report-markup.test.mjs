import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reportPath = new URL("../pages/report/report.wxml", import.meta.url);
const reportScriptPath = new URL("../pages/report/report.js", import.meta.url);
const dispatchPath = new URL("../pages/dispatch/dispatch.wxml", import.meta.url);
const dispatchScriptPath = new URL("../pages/dispatch/dispatch.js", import.meta.url);
const dispatchStylePath = new URL("../pages/dispatch/dispatch.wxss", import.meta.url);

test("工序选择项使用整行点击容器，避免手机端原生按钮按内容收缩", async () => {
  const markup = await readFile(reportPath, "utf8");

  assert.match(markup, /<view class="favorite-process"/);
  assert.match(markup, /<view class="all-processes-button"/);
  assert.match(markup, /<view class="process-row"/);
  assert.doesNotMatch(markup, /<button class="(?:favorite-process|all-processes-button|process-row)"/);
});

test("工位扫码入口连接真实扫描方法，不保留界面对比占位操作", async () => {
  const markup = await readFile(reportPath, "utf8");

  assert.match(markup, /bindtap="scanStationProcessCode"/);
  assert.match(markup, /selectionMode === 'station'/);
  assert.doesNotMatch(markup, /previewStationScan|PROTOTYPE/);
});

test("扫码结果直接展示工单名字和工序名字，并用小入口切换人工选择", async () => {
  const markup = await readFile(reportPath, "utf8");

  assert.match(markup, /class="key-label">工单/);
  assert.match(markup, /\{\{workOrder\.projectCode\}\}/);
  assert.match(markup, /class="key-label">工序/);
  assert.match(markup, /\{\{selectedProcess\.processName\}\}/);
  assert.match(markup, /class="compact-mode-button"/);
  assert.match(markup, /没有工序码？选择工序/);
  assert.doesNotMatch(markup, /class="mode-switcher"/);
});

test("报工主流程只保留工单、工序、数量、计时和操作按钮", async () => {
  const markup = await readFile(reportPath, "utf8");

  assert.match(markup, /class="work-order">工单 \{\{assignment\.projectCode\}\}/);
  assert.match(markup, /\{\{assignment\.processName\}\}/);
  assert.match(markup, /\{\{assignment\.quantity\}\}<\/text><text class="work-quantity-unit">件/);
  assert.match(markup, /\{\{elapsedText\}\}/);
  assert.match(markup, /结束报工/);
  assert.doesNotMatch(markup, /assignment\.productName|workOrder\.productName/);
  assert.doesNotMatch(markup, /计时方式|开工时间|结束时可以修改|一个工位固定一道工序/);
});

test("数量确认展示并行剩余数量提示，并绑定可编辑数量输入", async () => {
  const markup = await readFile(reportPath, "utf8");
  assert.match(markup, /剩余 \{\{finishRemainingQuantity\}\} 件/);
  assert.match(markup, /bindinput="onQuantityInput"/);
});

test("黑湖明确找不到工单后仅在提交弹窗提供退出，不在页面常驻显示", async () => {
  const [markup, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(reportScriptPath, "utf8")
  ]);

  assert.doesNotMatch(markup, /assignment\.canWorkerCancel/);
  assert.doesNotMatch(markup, /工单已删除|退出这单/);
  assert.match(script, /WORK_ORDER_NOT_FOUND/);
  assert.match(script, /title: "工单已删除"/);
  assert.match(script, /confirmText: "退出这单"/);
  assert.match(script, /\/v1\/assignments\/\$\{encodeURIComponent\(this\.data\.assignment\.id\)\}\/cancel/);
  assert.match(script, /不会提交数量/);
});

test("绣花报工采用工单、机器码、前后幅流程并保留多机任务切换", async () => {
  const [markup, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(reportScriptPath, "utf8")
  ]);
  assert.match(script, /\/v1\/flow\/embroidery-machine/);
  assert.match(script, /scanEmbroideryMachineCode/);
  assert.match(script, /chooseEmbroideryPart/);
  assert.match(script, /machineId: this\.data\.machineId/);
  assert.match(script, /embroideryPart: this\.data\.embroideryPart/);
  assert.match(script, /activeAssignments/);
  assert.match(script, /startAnotherEmbroidery/);
  assert.match(markup, /扫描机器码/);
  assert.match(markup, /data-part="前幅"/);
  assert.match(markup, /data-part="后幅"/);
  assert.match(markup, /bindtap="selectActiveAssignment"/);
  assert.match(markup, /再开一台/);
  assert.match(markup, /返回正在生产的机台/);
  assert.doesNotMatch(markup, /绣花机排程|schedule-machine/);
  assert.doesNotMatch(script, /\/v1\/embroidery\/schedule/);
});

test("员工报工入口采用后台模式，正常界面不提供测试模式切换", async () => {
  const [markup, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(reportScriptPath, "utf8")
  ]);
  assert.doesNotMatch(markup, /bindtap="setReportingMode"/);
  assert.doesNotMatch(markup, /reporting-mode-switch/);
  assert.doesNotMatch(markup, /reporting-mode-option|reporting-mode-current/);
  assert.match(script, /reportingMode: this\.data\.reportingMode/);
  assert.match(script, /defaultReportingMode/);
});

test("派单页按列编号12台机器，整块机器可点击且标签位于设备上方", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);
  assert.match(script, /\["3F-01", 28\.8, 26\.7\]/);
  assert.match(script, /\["3F-04", 28\.8, 63\.6\]/);
  assert.match(script, /\["3F-05", 50\.8, 26\.7\]/);
  assert.match(script, /\["3F-09", 72\.8, 26\.7\]/);
  assert.match(markup, /class="floor3-unit-target \{\{item\.state\}\}[^\"]*"[\s\S]*bindtap="selectUnit"/);
  assert.match(markup, /class="unit-chip"/);
  assert.match(style, /\.floor3-unit-target\s+\.unit-chip\s*\{[^}]*top:\s*20%[^}]*translate\(-50%,\s*-100%\)/);
});

test("8楼标签锚点与机器点击热区分离并按真实模型中心校准", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(script, /\["A-10",\s*28\.3,\s*40\.1,\s*"A-10",\s*"station"\]/);
  assert.match(script, /\["A-01",\s*28\.3,\s*81\.6,\s*"A-01",\s*"station"\]/);
  assert.match(script, /\["B-07",\s*52\.1,\s*40\.2,\s*"B-07",\s*"station"\]/);
  assert.match(markup, /floor8-unit-target \{\{item\.kind\}\}/);
  assert.match(style, /\.floor8-unit-target\.station\s*\{[^}]*width:\s*11%/);
  assert.match(style, /\.floor8-unit-target\.station\s+\.unit-chip[^{]*\{[^}]*left:\s*8rpx[^}]*translate\(-100%,\s*-50%\)/);
});

test("8楼选人只展示姓名，保留搜索、工序选择和历史依据入口", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(markup, /class="person-tile-name"/);
  assert.doesNotMatch(markup, /person-tile-station|item.boundUnitLabel/);
  assert.match(markup, /placeholder="搜索姓名"/);
  assert.match(markup, /bindtap="selectPersonProcess"/);
  assert.match(markup, /bindtap="openPeopleMenu"/);
  assert.match(script, /查看推荐依据/);
  assert.match(script, /\/v1\/dispatch\/prediction/);
  assert.match(script, /rankEmployees/);
  assert.match(style, /\.worker-station/);
});

test("数字孪生使用稳定方形旋转画布，控件留在视口内", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(markup, /class="map-shell"/);
  assert.match(markup, /scale-max="2\.2"/);
  assert.doesNotMatch(markup, /scale-value=/);
  assert.doesNotMatch(markup, /\sx="\{\{mapX\}\}"|\sy="\{\{mapY\}\}"/);
  assert.match(markup, /wx:if="\{\{mapGestureReady\}\}"/);
  assert.match(markup, /class="map-content [^"]+"/);
  assert.match(markup, /animation="false"/);
  assert.match(markup, /damping="40"/);
  assert.doesNotMatch(markup, /labelScale|labelAngle/);
  assert.match(style, /\.map-shell\s*\{[^}]*position:\s*relative/);
  assert.match(style, /\.map-movable\s*\{[^}]*width:\s*150%[^}]*height:\s*100%/);
  assert.match(style, /\.map-content\s*\{[^}]*width:\s*66\.6667%[^}]*height:\s*100%/);
  assert.match(script, /mapGestureReady:\s*true/);
  assert.doesNotMatch(script, /mapScaleCommand/);
  assert.match(script, /mapScaleText:\s*"100"/);
});

test("地图位移由原生手势层独立管理，逻辑层只同步缩放读数", async () => {
  const [markup, script] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8")
  ]);
  const scaleHandler = script.match(/onMapScale\(event\)\s*\{([\s\S]*?)\n\s*\},\n\n\s*resetMap/);

  assert.ok(scaleHandler, "应保留地图缩放读数处理器");
  assert.doesNotMatch(markup, /bindchange="onMapChange"/);
  assert.doesNotMatch(script, /onMapChange\(|pendingMapState|mapX: event\.detail\.x|mapY: event\.detail\.y/);
  assert.doesNotMatch(scaleHandler[1], /mapX|mapY/);
  assert.match(script, /pendingMapScaleText/);
  assert.match(script, /mapGestureReady:\s*false[\s\S]*mapGestureReady:\s*true/);
});

test("真机使用稳定的模型图片且机台点击不被触摸拦截", async () => {
  const [markup, script] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8")
  ]);

  assert.match(markup, /floor[38]-digital-twin\.jpg/);
  assert.match(markup, /fade-in="false"/);
  assert.match(markup, /binderror="onFloorImageError"/);
  assert.match(markup, /bindtap="selectUnit"/);
  assert.doesNotMatch(markup, /catchtouch(?:start|move|end|cancel)="stopMapGesture"/);
  assert.doesNotMatch(script, /stopMapGesture/);
  assert.match(script, /onFloorImageError/);
  assert.match(script, /retryFloorImage/);
});

test("派单页仅保留一个稳定的地图复位图标", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(style, /\.order-bar\s*\{[^}]*display:\s*flex/);
  assert.doesNotMatch(style, /\.order-bar\s*\{[^}]*grid-template-columns/);
  assert.equal((markup.match(/bindtap="resetMap"/g) || []).length, 1);
  assert.match(markup, /class="map-reset-button"[\s\S]*class="reset-arc"[\s\S]*class="reset-arrow"/);
  assert.doesNotMatch(markup, />放大<|>缩小<|>左转<|>右转<|class="map-controls"/);
  assert.doesNotMatch(script, /zoomIn\(|zoomOut\(|rotateLeft\(|rotateRight\(/);
  assert.match(style, /\.map-reset-button\s*\{[^}]*border-radius:\s*50%/);
  assert.match(style, /\.map-reset-button\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*\.96\)/);
  assert.match(style, /\.reset-arc\s*\{[^}]*border:\s*3rpx solid #1686f5/);
  assert.match(style, /\.reset-arrow\s*\{[^}]*border-left:\s*9rpx solid #1686f5/);
  assert.match(script, /mapGeometry\(isFloor3\)/);
});

test("3楼确认弹层使用紧凑纵向摘要并要求选择前幅或后幅", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(script, /selectedEmbroideryPart:\s*""/);
  assert.match(script, /chooseDispatchPart\(event\)/);
  assert.match(script, /embroideryPart:\s*this\.data\.selectedEmbroideryPart/);
  assert.match(markup, /data-part="前幅"[^>]*bindtap="chooseDispatchPart"/);
  assert.match(markup, /data-part="后幅"[^>]*bindtap="chooseDispatchPart"/);
  assert.match(markup, /disabled="\{\{submitting \|\| !selectedProcessId \|\| !selectedEmbroideryPart\}\}"/);
  assert.match(markup, /class="machine-summary"/);
  assert.match(markup, /class="dispatch-part-options"/);
  assert.doesNotMatch(markup, /class="confirm-grid"/);
  assert.doesNotMatch(style, /calc\(50%\s*-\s*5rpx\)/);
  assert.match(style, /\.machine-confirm-button\s*\{[^}]*width:\s*100%/);
});

test("不可分配或未绑定的3楼机器点击后提供明确反馈", async () => {
  const [markup, script] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8")
  ]);

  assert.match(script, /this\.data\.isFloor3[\s\S]*unit\.canAssign === false[\s\S]*wx\.showToast/);
  assert.match(script, /!this\.data\.selectedProcessId[\s\S]*当前工单没有可分配工序/);
  assert.match(markup, /item\.operatorMapped \? '' : 'unmapped'/);
  assert.match(markup, /未绑定/);
});

test("8楼人员选择支持多选并携带每人的工位批量提交", async () => {
  const [markup, script, style] = await Promise.all([
    readFile(dispatchPath, "utf8"),
    readFile(dispatchScriptPath, "utf8"),
    readFile(dispatchStylePath, "utf8")
  ]);

  assert.match(script, /selectedEmployeeIds:\s*\[\]/);
  assert.match(script, /blacklakeOperatorIds:\s*this\.data\.selectedEmployeeIds/);
  assert.match(script, /!this\.data\.isFloor3[\s\S]*unit\.canAssign/);
  assert.match(markup, /可多选/);
  assert.match(markup, /item\.selected \? 'selected' : ''/);
  assert.match(markup, /<checkbox /);
  assert.match(markup, /selectedEmployeeIds\.length/);
  assert.match(style, /\.checkbox\s*\{/);
  assert.match(style, /\.selected\s+\.checkbox/);
});

test("分配弹层操作按钮使用显式外边距，不依赖手机端不稳定的 grid gap", async () => {
  const style = await readFile(dispatchStylePath, "utf8");

  assert.match(style, /\.sheet-actions\s*\{[^}]*display:\s*flex/);
  assert.match(style, /\.sheet-actions\s+\.sheet-primary\s*\{[^}]*margin-left:\s*18rpx/);
  assert.doesNotMatch(style, /\.sheet-actions\s*\{[^}]*gap:/);
});

test("小程序全部页面使用派工页蓝绿主题，不再混用旧米白深绿配色", async () => {
  const styles = await Promise.all([
    readFile(new URL("../app.wxss", import.meta.url), "utf8"),
    readFile(dispatchStylePath, "utf8"),
    readFile(new URL("../pages/report/report.wxss", import.meta.url), "utf8"),
    readFile(new URL("../pages/recent/recent.wxss", import.meta.url), "utf8")
  ]);
  const allStyles = styles.join("\n").toLowerCase();

  assert.doesNotMatch(allStyles, /#f6f3eb|#fffefa|#16724a|#0c5335|#18342a/);
  assert.match(allStyles, /#0c2b68/);
  assert.match(allStyles, /#1686f5|#1685f8|#1788ff/);
  assert.match(allStyles, /#16c95a|#15c85a|#1dc869/);
});

test("员工页面等待后台派单，待开始任务只提供开始和结束主动作", async () => {
  const [markup, script] = await Promise.all([
    readFile(reportPath, "utf8"),
    readFile(reportScriptPath, "utf8")
  ]);
  assert.match(markup, /stage === 'waiting'/);
  assert.match(markup, /等待组长派单/);
  assert.match(markup, /bindtap="startAssignedWork"/);
  assert.match(markup, /bindtap="confirmFinish"/);
  assert.match(script, /\/v1\/assignments\/\$\{encodeURIComponent\(this\.data\.assignment\.id\)\}\/start/);
  assert.match(script, /assignment\.isDispatched/);
});
