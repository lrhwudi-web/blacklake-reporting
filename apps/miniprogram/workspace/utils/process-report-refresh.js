async function refreshProcessReports(api,orderId,processId,{active=()=>true,status=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxAttempts=30}={}){
 const cancelled=()=>Object.assign(new Error('已离开当前工序'),{code:'PROCESS_REFRESH_CANCELLED'});
 if(!active())throw cancelled();let response=await api.refreshProcessReports(orderId,processId),requested=response.sync?.refresh;
 if(!requested?.requestId)throw new Error('报工刷新请求未能确认，请重试。');
 for(let n=0;n<maxAttempts;n++){
  if(!active())throw cancelled();status(response.sync);const state=response.sync?.refresh;
  if(state?.requestId===requested.requestId&&state.completed)return response;
  if(state?.state==='FAILED')throw new Error('黑湖报工读取失败，已保留记录，请稍后再试。');
  await wait(Math.min(1000+n*250,2000));if(!active())throw cancelled();response=await api.loadProcessReports(orderId,processId);
 }
 throw new Error('黑湖报工仍在排队更新，已保留记录，稍后将自动核对进度。');
}
module.exports={refreshProcessReports};
