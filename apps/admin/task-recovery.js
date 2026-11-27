// Administrative recovery uses existing assignment states. No task is changed by opening this page.
(() => {
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const labels={READY:"待开始",IN_PROGRESS:"生产中",REPORTING:"提交中",NEEDS_REVIEW:"结果待核对",QUANTITY_PENDING:"完工待核量",COMPLETED:"已完成",CANCELLED:"已撤销"};
  const flagLabels={WAITING_LONG:"待开始过久",CROSS_DAY:"跨日未结束",RESULT_UNKNOWN:"需核对报工结果",QUANTITY_PENDING:"数量待核对"};
  const actionLabels={quantity:"核量并提交黑湖","void-quantity":"作废待核量记录","confirm-result":"黑湖已有记录","missing-result":"确认黑湖无记录",CONFIRM_PENDING_QUANTITY:"核量报工成功",SUBMIT_PENDING_QUANTITY:"提交核量报工",QUANTITY_SUBMIT_FAILED:"报量未成功",QUANTITY_RESULT_UNKNOWN:"报量结果待核对",VOID_PENDING_QUANTITY:"作废待核量记录",CONFIRM_REPORT_RESULT:"确认黑湖已报",REPORT_RESULT_NOT_CREATED:"确认黑湖未报",finish:"代登记完工","correct-time":"更正结束时间","cancel-ready":"撤销未开始任务","recover-binding":"恢复手机换绑",ADMIN_FINISH_PENDING_QUANTITY:"代登记完工",ADMIN_CORRECT_END_TIME:"更正结束时间",ADMIN_CANCEL_READY:"撤销未开始任务",ADMIN_RECOVER_BINDING:"恢复手机换绑"};
  let root=null,api=null,notify=()=>{},onReview=()=>{},revision=0,listRequest=0,detailRequest=0,personRequest=0;
  const s={loaded:false,loading:false,error:"",rows:[],summary:{},total:0,offset:0,limit:30,status:"OPEN",category:"ALL",query:"",waitingMinutes:60,serverTime:"",selected:"",detail:null,detailLoading:false,modal:null,form:{},saving:false,uncertain:false,operation:null,conflict:false,success:"",people:[],peopleLoaded:false,person:null,personLoading:false,personError:"",bindingResult:null,demo:false};
  const connected=()=>root?.isConnected;
  const inputTime=v=>String(v||"").replace(" ","T").slice(0,16);
  const expiryTime=v=>new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  const actionButton=(action,text,disabled=false)=>`<button type="button" class="${['finish','quantity'].includes(action)?'primary-small':'secondary-button'}" data-tr="${action}" ${disabled?'disabled':''}>${text}</button>`;
  function summary() {
    return `<div class="tr-metrics">${[["READY","待开始"],["IN_PROGRESS","生产中"],["NEEDS_REVIEW","结果待核对"],["QUANTITY_PENDING","完工待核量"]].map(([key,text])=>`<button type="button" data-tr="status" data-status="${key}" class="${s.status===key?'active':''}"><span>${text}</span><strong>${s.summary[key]??(s.loaded?0:"—")}</strong></button>`).join("")}</div>`;
  }
  function table() {
    if(!s.rows.length)return `<div class="tr-empty">${s.loading?'正在读取任务…':s.loaded?'当前条件下没有任务。':'点击刷新读取任务。'}</div>`;
    return `<div class="tr-table-scroll"><table class="tr-table"><thead><tr><th>人员 / 工单</th><th>工序 / 工位</th><th>状态</th><th>派出 / 开始时间</th><th>处理</th></tr></thead><tbody>${s.rows.map(row=>`<tr class="${s.selected===row.id?'selected':''}"><td><strong>${esc(row.operatorName)}</strong><span>${esc(row.projectCode)}</span></td><td><strong>${esc(row.processName)}</strong><span>${esc(row.machineId||row.stationName||'未记录工位')}</span></td><td><b class="tr-status tr-${esc(row.status)}">${esc(labels[row.status]||row.status)}</b>${row.flags.map(flag=>`<small class="tr-flag">${esc(flagLabels[flag])}</small>`).join('')}</td><td><time>${esc(row.publishedAt||'—')}</time><span>${row.startedAt?'开始 '+esc(row.startedAt):'尚未开始'}</span></td><td><button type="button" class="secondary-button" data-tr="select" data-id="${esc(row.id)}">查看处理</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  actionLabels.AUTO_OVERNIGHT_PAUSE='凌晨补暂停';
  const overnightLabels={'team-leader':'所属组长下班','other-leader':'其他组长下班',majority:'多数员工结束时间中位数','employee-end':'邻近员工结束记录','employee-pause':'邻近员工暂停记录','task-activity':'任务最后活动',cutoff:'凌晨2点旧规则',unavailable:'参考待核对'};
  function overnightNote() {
    const item=s.detail?.overnightClockout;if(!item)return '';
    if(item.status==='ALREADY_PAUSED')return '<p class="tr-note">凌晨检查：原已暂停。</p>';
    const outcome=item.pauseAt?'暂停于 '+item.pauseAt:'未补暂停';
    return `<p class="tr-note">凌晨补暂停：${esc(overnightLabels[item.referenceKind]||'参考待核对')} · ${esc(outcome)} · 结束样本 ${esc(item.sampleCount)} / 当班人员 ${esc(item.population)}${item.reason?'。'+esc(item.reason):''}</p>`;
  }
  function detail() {
    if(s.detailLoading)return '<section class="tr-detail"><p>正在读取最新状态…</p></section>';
    const row=s.detail?.assignment;if(!row)return '';
    return `<section class="tr-detail" id="tr-detail" aria-label="任务处理详情"><div class="tr-detail-head"><div><p>${esc(row.projectCode)} · ${esc(labels[row.status]||row.status)}</p><h2>${esc(row.operatorName)} · ${esc(row.processName)}</h2></div><button type="button" class="secondary-button" data-tr="refresh-detail" ${s.saving?'disabled':''}>刷新详情</button></div>
      <dl class="tr-facts"><div><dt>工位</dt><dd>${esc(row.machineId||row.stationName||'—')}</dd></div><div><dt>开始时间</dt><dd>${esc(row.startedAt||'尚未开始')}</dd></div><div><dt>结束时间</dt><dd>${esc(row.endedAt||'尚未结束')}</dd></div><div><dt>已登记工时</dt><dd>${row.durationSeconds==null?'尚未登记':(row.durationSeconds/3600).toFixed(2)+' 小时'}</dd></div></dl>
      ${overnightNote()}
      <div class="tr-detail-actions">${row.canCancelReady?actionButton('cancel-ready','撤销未开始任务',s.saving):''}${row.canFinish?actionButton('finish','代登记完工',s.saving):''}${row.canCorrectTime?actionButton('correct-time','更正结束时间',s.saving):''}${row.canConfirmQuantity?actionButton('quantity','核量并提交黑湖',s.saving):''}${row.canVoidQuantity?actionButton('void-quantity','作废无效记录',s.saving):''}${row.status==='NEEDS_REVIEW'?actionButton('confirm-result','黑湖已有记录',s.saving)+actionButton('missing-result','确认黑湖无记录',s.saving):''}${actionButton('person','处理手机换绑',s.saving)}</div>
      <p class="tr-note">${row.status==='QUANTITY_PENDING'?'实际生产请核量并提交黑湖；测试单或误登记可直接确认作废。补量保留原开始、结束时间与工时。':row.canFinish?'代登记完工只记录实际时间，之后由员工或后台核量报工。':row.status==='REPORTING'?'任务正在提交，暂不能结束、撤销或换绑；请稍后刷新核对。':row.status==='NEEDS_REVIEW'?'先在黑湖核对实际报工结果，再按原后台核对流程处理，不能直接强制结束。':row.status==='IN_PROGRESS'?'首批代完工仅支持8楼待核量派单；其他任务仍由员工按原流程确认数量报工。':'处置以最新状态为准；多人共用工位时，不影响其他人的活动任务。'}</p>
      <details class="tr-audit" open><summary>处理记录 ${s.detail.eventsTotal||0} 条</summary>${s.detail.events?.length?s.detail.events.map(event=>`<article><div><strong>${esc(actionLabels[event.action]||event.action)}</strong><time>${esc(event.createdAt)}</time></div><p>${esc(event.reason)}</p><small>${esc(event.actor)}${event.actualAt?' · 实际时间 '+esc(event.actualAt):''}</small>${event.before?.endedAt||event.after?.endedAt?`<p class="tr-audit-change">结束时间：${esc(event.before?.endedAt||'未登记')} → ${esc(event.after?.endedAt||'未登记')}<br>工时：${event.before?.durationSeconds==null?'未登记':esc(event.before?.durationSeconds)+' 秒'} → ${event.after?.durationSeconds==null?'未登记':esc(event.after?.durationSeconds)+' 秒'}</p>`:''}</article>`).join(''):'<p>暂无后台处置记录。员工原报工和历史审计仍保留在原模块。</p>'}${s.detail.eventsTruncated?'<p>此处仅显示最近100条，原始审计仍保留。</p>':''}</details></section>`;
  }
  function phone() {
    return `<details class="tr-binding" id="tr-binding"><summary>手机损坏、丢失或更换微信</summary><p>先核验本人身份并处理活动任务，再撤销旧微信和会话。新手机沿用现有小程序的姓名与确认码绑定流程。</p>
      <label>选择人员<select id="tr-person" ${s.saving?'disabled':''}><option value="">${s.peopleLoaded?'请选择人员':'点击此处加载人员'}</option>${s.people.map(p=>`<option value="${p.blacklakeOperatorId}" ${s.person?.blacklakeOperatorId===p.blacklakeOperatorId?'selected':''}>${esc(p.name)} · ${p.blacklakeOperatorId}</option>`).join('')}</select></label>
      ${s.personLoading?'<p>正在核对绑定与任务状态…</p>':''}${s.personError?`<p class="tr-error" role="alert">${esc(s.personError)}</p>`:''}
      ${s.person?`<div class="tr-person-context"><strong>${esc(s.person.name)}</strong><span>人员编号 ${s.person.blacklakeOperatorId} · ${s.person.bound?'已绑定微信':'当前未绑定微信'}</span>${s.person.activeAssignments.length?`<p class="tr-error">还有 ${s.person.activeAssignments.length} 笔活动任务，请先处置。</p><div class="tr-person-tasks">${s.person.activeAssignments.map(row=>`<button type="button" class="secondary-button" data-tr="select" data-id="${esc(row.id)}">${esc(row.projectCode)} · ${esc(labels[row.status]||row.status)}</button>`).join('')}</div>`:'<p>当前没有待开始、进行中或结果待核对任务。</p>'}${actionButton('recover-binding','核验身份并恢复换绑',!s.person.canRecover||s.saving)}</div>`:''}
      ${s.bindingResult?`<div class="tr-binding-code" role="status"><strong>${esc(s.bindingResult.name)}的新绑定确认码</strong><b>${s.bindingResult.codeUsed?'已使用':s.bindingResult.codeExpired?'已过期':esc(s.bindingResult.confirmationCode)}</b><span>有效期至 ${esc(expiryTime(s.bindingResult.expiresAt))}（北京时间）。仅交给已核验的本人；旧会话已撤销。</span></div>`:''}</details>`;
  }
  function modal() {
    if(!s.modal)return '';
    const recovery=s.modal==='recover-binding',row=s.detail?.assignment,person=s.person;
    return `<div class="tr-modal-backdrop"><section class="tr-dialog" role="dialog" aria-modal="true" aria-labelledby="tr-dialog-title"><h2 id="tr-dialog-title">${esc(actionLabels[s.modal])}</h2><p>${esc(recovery?person?.name:row?.operatorName)}${recovery?' · 人员编号 '+esc(person?.blacklakeOperatorId):' · '+esc(row?.projectCode)+' · '+esc(row?.processName)}</p>
      <form id="tr-action-form">${['finish','correct-time'].includes(s.modal)?`<label>实际结束时间（北京时间）<input id="tr-ended" name="actualEndedAt" type="datetime-local" value="${esc(s.form.actualEndedAt||'')}" max="${esc(inputTime(s.serverTime))}" required ${s.saving?'disabled':''}></label><p class="tr-note">按实际结束时间重算工时，仍只扣现有午休；不新增暂停或其他手机状态。</p>`:''}
      ${s.modal==='quantity'?`<label>${row.isQualityInspection?'实际合格数':'实际完成数量'}<input name="quantity" type="number" min="0" step="1" value="${esc(s.form.quantity)}" required ${s.saving?'disabled':''}></label>${row.isQualityInspection?`<label>实际不良数<input name="defectQuantity" type="number" min="0" step="1" value="${esc(s.form.defectQuantity)}" required ${s.saving?'disabled':''}></label><fieldset><legend>不良原因（有不良时必选）</legend>${(s.detail.defectReasons||[]).map(r=>`<label class="tr-checkbox"><input type="checkbox" name="defectCode" value="${esc(r.code)}" ${(s.form.defectCodes||[]).includes(r.code)?'checked':''} ${s.saving?'disabled':''}>${esc(r.name)}</label>`).join('')}</fieldset>`:''}<p class="tr-note">按实际完成数量填写，不自动使用计划数。将提交黑湖并保留原工时；无实际生产的记录请作废。</p>`:''}
      ${s.modal==='confirm-result'?`<label>黑湖报工记录编号（选填）<input name="blacklakeOutputId" value="${esc(s.form.blacklakeOutputId||'')}" maxlength="128" ${s.saving?'disabled':''}></label>`:''}
      ${['confirm-result','missing-result'].includes(s.modal)?'<p class="tr-note">必须先在黑湖核对人员、工单、工序、数量和报工时间，再记录核对依据。确认无记录只恢复可提交状态，不会自动重报。</p>':''}
      ${s.modal==='void-quantity'?'<p class="tr-note">仅用于测试或误登记。保留原工时和操作记录，不提交黑湖，不删除历史。</p>':''}
      ${recovery?`<label>输入本人完整姓名<input name="confirmedName" id="tr-confirmed-name" value="${esc(s.form.confirmedName||'')}" autocomplete="off" required ${s.saving?'disabled':''}></label><label class="tr-checkbox"><input name="identityConfirmed" type="checkbox" ${s.form.identityConfirmed?'checked':''} ${s.saving?'disabled':''}>已核验本人身份，并确认需要撤销旧微信及旧会话</label>`:''}
      
      <p class="tr-note">${s.modal==='cancel-ready'?'只撤销尚未开始的派单，自动记录操作人和时间，不报产量。':recovery?'新确认码10分钟有效，只交给本人；原任务和报工记录不会删除。':'原始时间与本次更正前后值都会留存，操作完成后员工重新进入小程序可读取最新状态。'}</p>
      ${s.error?`<p class="tr-error" role="alert">${esc(s.error)}</p>`:''}${s.conflict?'<button type="button" class="secondary-button" data-tr="refresh-state">刷新状态并重新核对</button>':''}
      ${s.uncertain?receiptControls():''}<div class="tr-dialog-actions"><button type="button" class="secondary-button" data-tr="close-modal" ${s.saving||s.uncertain?'disabled':''}>返回</button><button class="primary-small" type="submit" ${s.saving||s.uncertain||s.conflict?'disabled':''}>${s.saving?'正在处理…':'确认'+esc(actionLabels[s.modal])}</button></div></form></section></div>`;
  }
  const receiptControls=()=>'<div class="tr-receipt"><p>回执待确认，请先读取本次结果；不会自动重复提交。</p><button type="button" class="secondary-button" data-tr="receipt">读取本次回执</button><button type="button" class="secondary-button" data-tr="retry-operation">重试原请求（同一标识）</button></div>';
  function render() {
    if(!connected())return;
    const phoneOpen=root.querySelector('#tr-binding')?.open;
    root.innerHTML=`<header class="tr-heading"><div><p>现场任务处置</p><h1>待处理任务</h1><span>集中处理漏结束、遗留派单和身份恢复</span></div><button type="button" class="primary-small" data-tr="refresh" ${s.loading||s.saving?'disabled':''}>刷新任务</button></header>
      ${s.demo?'<p class="tr-error">演示模式不能读取或修改正式任务。</p>':''}${s.success?`<p class="tr-success" role="status">${esc(s.success)}</p>`:''}${s.error&&!s.modal?`<p class="tr-error" role="alert">${esc(s.error)}</p>`:''}${s.uncertain&&!s.modal?receiptControls():''}
      ${summary()}<form class="tr-filters" id="tr-filter-form"><label>任务状态<select id="tr-status"><option value="OPEN">全部未结束</option><option value="ALL">全部记录</option>${Object.entries(labels).map(([v,text])=>`<option value="${v}" ${s.status===v?'selected':''}>${text}</option>`).join('')}</select></label><label>待核实类型<select id="tr-category">${[['ALL','全部类型'],...Object.entries(flagLabels)].map(([v,text])=>`<option value="${v}" ${s.category===v?'selected':''}>${text}</option>`).join('')}</select></label><label>人员 / 工单 / 工序<input id="tr-query" value="${esc(s.query)}" maxlength="100" placeholder="搜索姓名、工单或人员编号"></label><label>待开始提醒（分钟）<input id="tr-waiting" type="number" min="1" max="10080" value="${s.waitingMinutes}"></label><button type="submit" class="secondary-button" ${s.loading||s.saving?'disabled':''}>查询</button></form>
      <p class="tr-scope">仅本系统任务 · 跨日与停留过久仅提示待核实，不代表生产异常 · ${esc(s.serverTime||'尚未读取')}</p><section class="tr-list" aria-label="任务列表">${table()}<div class="tr-pagination"><span>共 ${s.total} 条 · 第 ${Math.floor(s.offset/s.limit)+1} 页</span><div><button type="button" class="secondary-button" data-tr="previous" ${s.offset===0||s.loading||s.saving?'disabled':''}>上一页</button><button type="button" class="secondary-button" data-tr="next" ${s.offset+s.rows.length>=s.total||s.loading||s.saving?'disabled':''}>下一页</button></div></div></section>${detail()}${phone()}${modal()}`;
    root.querySelector('#tr-status').value=s.status;
    if(phoneOpen)root.querySelector('#tr-binding').open=true;
  }
  async function load() {
    if(s.demo)return render();const epoch=revision,id=++listRequest;s.loading=true;render();
    try{const params=new URLSearchParams({status:s.status,category:s.category,q:s.query,offset:s.offset,limit:s.limit,waitingMinutes:s.waitingMinutes});const value=await api('/v1/admin/task-recovery?'+params);if(epoch!==revision||id!==listRequest)return;Object.assign(s,{rows:value.assignments,total:value.total,summary:value.summary,serverTime:value.serverTime,loaded:true});}
    catch(error){if(epoch===revision&&id===listRequest)s.error=error.message||'任务读取失败';}
    finally{if(epoch===revision&&id===listRequest){s.loading=false;render();}}
  }
  async function select(id,{scroll=true}={}) {
    const epoch=revision,request=++detailRequest;s.selected=id;s.detailLoading=true;s.error='';render();
    try{const value=await api('/v1/admin/task-recovery/assignments/'+encodeURIComponent(id));if(epoch!==revision||request!==detailRequest)return;s.detail=value;}
    catch(error){if(epoch===revision&&request===detailRequest){s.detail=null;s.error=error.message;}}
    finally{if(epoch===revision&&request===detailRequest){s.detailLoading=false;render();if(scroll)root?.querySelector('#tr-detail')?.scrollIntoView({block:'start',behavior:'smooth'});}}
  }
  async function loadPeople() {
    if(s.peopleLoaded||s.demo)return;
    try{const value=await api('/v1/admin/operators');s.people=value.operators||[];s.peopleLoaded=true;render();}
    catch(error){s.personError=error.message;render();}
  }
  async function person(id) {
    const epoch=revision,request=++personRequest;s.personLoading=true;s.personError='';s.person=null;s.bindingResult=null;render();
    try{const value=await api('/v1/admin/task-recovery/operators/'+encodeURIComponent(id));if(epoch!==revision||request!==personRequest)return;s.person=value;}
    catch(error){if(epoch===revision&&request===personRequest)s.personError=error.message;}
    finally{if(epoch===revision&&request===personRequest){s.personLoading=false;render();const section=root?.querySelector('#tr-binding');if(section){section.open=true;section.scrollIntoView({block:'start',behavior:'smooth'});}}}
  }
  function openAction(action) {
    if(s.saving||s.uncertain||s.demo)return;
    const row=s.detail?.assignment;if(action==='finish'&&!row?.canFinish||action==='correct-time'&&!row?.canCorrectTime||action==='cancel-ready'&&!row?.canCancelReady||action==='recover-binding'&&!s.person?.canRecover)return;
    s.modal=action;s.error='';s.conflict=false;s.form={quantity:'',defectQuantity:'0',defectCodes:[],blacklakeOutputId:'',actualEndedAt:inputTime(action==='correct-time'?row.endedAt:s.serverTime),confirmedName:'',identityConfirmed:false};render();root.querySelector('.tr-dialog input,.tr-dialog textarea')?.focus();
  }
  async function succeeded(value) {
    const path=s.operation?.path||'',kind=path.split('/').at(-1);
    const expectedActions={quantity:'CONFIRM_PENDING_QUANTITY','void-quantity':'VOID_PENDING_QUANTITY','confirm-result':'CONFIRM_REPORT_RESULT','missing-result':'REPORT_RESULT_NOT_CREATED',finish:'ADMIN_FINISH_PENDING_QUANTITY','correct-time':'ADMIN_CORRECT_END_TIME','cancel-ready':'ADMIN_CANCEL_READY'};
    const confirmed=kind==='recover-binding'
      ? value?.bindingRecovery===true&&value.blacklakeOperatorId===Number(path.match(/operators\/(\d+)\//)?.[1])&&Number.isFinite(Date.parse(value.expiresAt))&&(/^\d{6}$/.test(value.confirmationCode||'')||value.codeUsed===true||value.codeExpired===true)
      : value?.assignment?.id===decodeURIComponent(path.split('/').at(-2)||'')&&value.action===expectedActions[kind]&&(kind==='quantity'?['COMPLETED','QUANTITY_PENDING','NEEDS_REVIEW','REPORTING'].includes(value.assignment.status):value.assignment.status===(['cancel-ready','void-quantity'].includes(kind)?'CANCELLED':kind==='confirm-result'?'COMPLETED':kind==='missing-result'?value.assignment.status:'QUANTITY_PENDING'));
    if(!confirmed)throw new Error('未收到完整处置回执，请读取本次结果核对。');
    s.uncertain=false;s.saving=false;s.modal=null;s.operation=null;s.error='';s.conflict=false;
    s.success=value.bindingRecovery?'旧微信和旧会话已撤销，请将新确认码交给本人完成绑定。':'处置已保存，员工重新进入小程序后会读取最新任务状态。';
    if(kind==='quantity'){s.success=value.assignment.status==='COMPLETED'?'数量已提交黑湖，任务已完成。':value.assignment.status==='QUANTITY_PENDING'?'本次未完成报量，记录仍待核量，请核实后重试或作废。':'提交结果待核对，请先核对黑湖，不要重复报工。';}
    if(kind==='void-quantity')s.success='无效待核量记录已作废，历史和工时保留，未向黑湖报量。';
    if(['confirm-result','missing-result'].includes(kind))s.success=kind==='confirm-result'?'已登记黑湖已有报工，任务完成。':'已登记黑湖无记录；原任务恢复为可提交状态，不会自动重报。';
    if(value.bindingRecovery){s.bindingResult=value;try{s.person=await api('/v1/admin/task-recovery/operators/'+value.blacklakeOperatorId);}catch{ s.personError='换绑已保存，人员状态刷新失败，请稍后重新读取。'; }}
    await load();if(s.selected)await select(s.selected,{scroll:false});if(!value.bindingRecovery)notify(s.success);render();if(value.bindingRecovery)root?.querySelector('.tr-binding-code')?.scrollIntoView({block:'center'});
  }
  async function sendOperation() {
    if(!s.operation||s.saving)return;s.saving=true;render();
    try{const value=await api(s.operation.path,{method:'POST',headers:{'Idempotency-Key':s.operation.id},body:JSON.stringify(s.operation.body)});await succeeded(value);}
    catch(error){s.saving=false;s.error=error.message||'网络异常';if(!error.status||error.status>=500){s.uncertain=true;}else{s.uncertain=false;s.conflict=error.status===409;}render();}
  }
  async function submit() {
    if(s.saving||s.uncertain||s.conflict||!s.modal)return;
    const recovery=s.modal==='recover-binding';s.operation={id:crypto.randomUUID(),path:recovery?`/v1/admin/task-recovery/operators/${s.person.blacklakeOperatorId}/recover-binding`:`/v1/admin/task-recovery/assignments/${encodeURIComponent(s.detail.assignment.id)}/${s.modal}`,body:recovery?{expectedVersion:s.person.version,confirmedName:s.form.confirmedName,identityConfirmed:s.form.identityConfirmed}:{expectedVersion:s.detail.assignment.version,...(['finish','correct-time'].includes(s.modal)?{actualEndedAt:s.form.actualEndedAt}:{}),...(s.modal==='quantity'?{quantity:s.form.quantity===''?null:Number(s.form.quantity),defectQuantity:s.form.defectQuantity===''?null:Number(s.form.defectQuantity),defectCodes:s.form.defectCodes}:{}),...(s.modal==='confirm-result'?{blacklakeOutputId:s.form.blacklakeOutputId}:{})}};
    await sendOperation();
  }
  async function receipt() {
    if(!s.operation||s.saving)return;s.saving=true;render();
    try{const value=await api('/v1/admin/task-recovery/operations/'+s.operation.id);await succeeded(value);}
    catch(error){s.saving=false;s.error=error.message||'仍未取得回执，请稍后再查';render();}
  }
  window.BlacklakeTaskRecovery={mount(element,options={}) {
    if(root===element)return;revision++;root=element;api=options.api;notify=options.notify||(()=>{});onReview=options.onReview||(()=>{});s.demo=Boolean(options.demo);
    if(!root){s.bindingResult=null;return;}if(s.demo){s.rows=[];s.summary={};s.detail=null;s.person=null;s.people=[];s.peopleLoaded=false;s.total=0;}root.dataset.mounted='true';render();
    root.addEventListener('input',event=>{const target=event.target;if(target.name&&s.modal){if(target.name==='defectCode'){s.form.defectCodes=target.checked?[...new Set([...s.form.defectCodes,target.value])]:s.form.defectCodes.filter(c=>c!==target.value);}else s.form[target.name]=target.type==='checkbox'?target.checked:target.value;}});
    root.addEventListener('change',event=>{const target=event.target;if(target.name&&s.modal){if(target.name==='defectCode'){s.form.defectCodes=target.checked?[...new Set([...s.form.defectCodes,target.value])]:s.form.defectCodes.filter(c=>c!==target.value);}else s.form[target.name]=target.type==='checkbox'?target.checked:target.value;}if(target.id==='tr-person'&&target.value)void person(target.value);if(target.id==='tr-category'&&target.value==='QUANTITY_PENDING'&&root.querySelector('#tr-status').value==='OPEN')root.querySelector('#tr-status').value='QUANTITY_PENDING';});
    root.addEventListener('submit',event=>{event.preventDefault();if(event.target.id==='tr-action-form')void submit();else if(event.target.id==='tr-filter-form'&&!s.saving){s.status=root.querySelector('#tr-status').value;s.category=root.querySelector('#tr-category').value;s.query=root.querySelector('#tr-query').value;s.waitingMinutes=Number(root.querySelector('#tr-waiting').value);s.offset=0;s.error='';void load();}});
    root.addEventListener('click',event=>{const target=event.target.closest('[data-tr]');if(!target||target.disabled)return;const action=target.dataset.tr;
      if(action==='select')void select(target.dataset.id);else if(action==='refresh')void load();else if(action==='refresh-detail')void select(s.selected,{scroll:false});else if(action==='previous'||action==='next'){s.offset=Math.max(0,s.offset+(action==='next'?s.limit:-s.limit));void load();}
      else if(action==='status'){s.status=target.dataset.status;s.category='ALL';s.offset=0;void load();}
      else if(['finish','correct-time','cancel-ready','recover-binding','quantity','void-quantity','confirm-result','missing-result'].includes(action))openAction(action);
      else if(action==='person'){void loadPeople();void person(s.detail.assignment.blacklakeOperatorId);}
      else if(action==='open-review')void onReview(s.selected);
      else if(action==='close-modal'&&!s.saving&&!s.uncertain){s.modal=null;s.error='';render();}
      else if(action==='receipt')void receipt();else if(action==='retry-operation')void sendOperation();
      else if(action==='refresh-state'){s.modal=null;s.conflict=false;s.error='';void load();if(s.selected)void select(s.selected,{scroll:false});if(s.person)void person(s.person.blacklakeOperatorId);}
    });
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&s.modal&&!s.saving&&!s.uncertain){s.modal=null;render();}if(event.key==='Tab'&&s.modal){const items=[...root.querySelectorAll('.tr-dialog button:not(:disabled),.tr-dialog input:not(:disabled),.tr-dialog textarea:not(:disabled)')];if(items.length&&event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}else if(items.length&&!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}}});
    root.addEventListener('toggle',event=>{if(event.target.id==='tr-binding'&&event.target.open)void loadPeople();},true);
    const entry=options.assignmentId;window.blacklakeRecoveryEntry='';void load().then(()=>{if(entry&&root)void select(entry);});
  }};
})();

