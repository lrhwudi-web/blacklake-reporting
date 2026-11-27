async function refreshCurrentOrder(api,id,{active=()=>true,status=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxAttempts=20}={}){
 const cancelled=()=>Object.assign(new Error('已离开当前工单'),{code:'ORDER_REFRESH_CANCELLED'});
 if(!active())throw cancelled();
 let response=await api.refreshOrderDetail(id);const requested=response.sync?.refresh;
 if(!requested)return response;
 for(let attempt=0;attempt<maxAttempts;attempt++){
  if(!active())throw cancelled();status(response.sync);
  const current=response.sync?.refresh;
  if(current?.completed&&current.jobId===requested.jobId&&current.generation>=requested.generation)return response;
  if(current?.state==='FAILED')throw Object.assign(new Error('这张工单更新失败，已保留上次资料，请稍后重试。'),{code:'ORDER_REFRESH_FAILED'});
  await wait(Math.min(1000+attempt*250,2000));if(!active())throw cancelled();
  response=await api.loadOrderDetail(id);
 }
 throw Object.assign(new Error('这张工单仍在后台更新，已保留上次资料；请稍后再点刷新。'),{code:'ORDER_REFRESH_PENDING'});
}
module.exports={refreshCurrentOrder};
