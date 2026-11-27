// Categories also define the explicit team scope for leader clock-out operations.
(() => {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.createPeopleGroupsManager = ({ api, notify }) => {
    const ALL = '@all';
    const state = { loaded:false, loading:false, saving:false, uncertain:false, error:'', revision:0, managed:false, groups:[], allPosition:0, employees:[], leaders:[], selected:'', draft:null, query:'' };
    const ordered = () => {const groups=state.groups.slice();groups.splice(Math.min(state.allPosition||0,groups.length),0,{id:ALL,name:'全部'});return groups;};
    const current = () => state.groups.find((g) => g.id === state.selected);
    const choose = (id) => { state.selected=id;state.draft=id==='new'?{id:'',name:'',blacklakeOperatorIds:[]}:structuredClone(current());state.query='';state.error=''; };
    const repaint = () => { const node=document.querySelector('#people-groups-pane');if(node)node.outerHTML=render(); };
    const dirty = () => Boolean(state.draft && JSON.stringify(state.draft)!==JSON.stringify(current()));
    const memberList = () => {
      const query=state.query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
      const members=state.employees.filter((p)=>!query||`${p.name} ${p.description || ''} ${p.blacklakeOperatorId}`.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query));
      const known=new Set(state.employees.map((p)=>p.blacklakeOperatorId));
      const missing=(state.draft?.blacklakeOperatorIds||[]).filter((id)=>!known.has(id)).map((id)=>({blacklakeOperatorId:id,name:`暂不在当前名单 · ${id}`}));
      return [...members,...(query?[]:missing)].map((p)=>`<label class="pg-member"><input type="checkbox" data-pg-member="${p.blacklakeOperatorId}" ${state.draft?.blacklakeOperatorIds.includes(p.blacklakeOperatorId)?'checked':''} ${state.saving?'disabled':''}><span>${esc(p.name)}</span></label>`).join('')||'<p class="pg-empty">没有匹配的人员</p>';
    };
    const groupList = () => ordered().map((g,index,list)=>{
      const blocked=state.loading||state.saving||state.uncertain;
      const label=g.id===ALL?`<div class="pg-all"><span>全部</span><strong>${state.employees.length} 人</strong><small>仅排序</small></div>`:`<button class="pg-group ${g.id===state.selected?'active':''}" data-action="pg-select" data-id="${esc(g.id)}" ${state.saving?'disabled':''}><span>${esc(g.name)}</span><small>${g.blacklakeOperatorIds.filter((id)=>state.employees.some((p)=>p.blacklakeOperatorId===id)).length} 人</small></button>`;
      return `<div class="pg-group-row" data-group-id="${esc(g.id)}">${label}<div class="pg-moves"><button type="button" data-action="pg-move-up" data-id="${esc(g.id)}" aria-label="上移${esc(g.name)}" title="上移${esc(g.name)}" ${blocked||index===0?'disabled':''}>上移</button><button type="button" data-action="pg-move-down" data-id="${esc(g.id)}" aria-label="下移${esc(g.name)}" title="下移${esc(g.name)}" ${blocked||index===list.length-1?'disabled':''}>下移</button></div></div>`;
    }).join('');
    function render() {
      const draft=state.draft;
      return `<section id="people-groups-pane" class="pg-pane" aria-label="人员分类管理">
        <div class="pg-heading"><div><h2>人员分类</h2><p>管理选人分类，员工可加入多个分类。</p></div><div class="pg-toolbar"><button class="secondary-button" data-action="pg-refresh" ${state.loading||state.saving?'disabled':''}>${state.loading?'读取中…':'刷新'}</button><button class="primary-small" data-action="pg-new" ${!state.loaded||state.loading||state.saving||state.uncertain?'disabled':''}>新增分类</button></div></div>
        ${state.error?`<p class="pg-error" role="alert">${esc(state.error)}</p>`:''}
        <p class="pg-order-note">上移／下移后自动保存顺序；“全部”仅调整显示位置，仍包含全部人员。手机端选人按此顺序显示，重新打开或等待刷新后生效。</p>${!state.loaded?`<div class="pg-empty">${state.loading?'正在读取分类…':'暂未读取分类，请点击刷新。'}</div>`:`<div class="pg-workspace"><aside class="pg-groups" aria-label="分类列表">${groupList()}</aside><div class="pg-editor">${draft?`
          <div class="pg-editor-heading"><h3>${state.selected==='new'?'新增分类':'编辑分类'}</h3>${state.selected!=='new'?`<button class="pg-delete" data-action="pg-delete" ${state.saving||state.uncertain?'disabled':''}>删除分类</button>`:''}</div>
          <label class="pg-field" for="pg-name">分类名称<input id="pg-name" maxlength="40" value="${esc(draft.name)}" placeholder="例如：后道缝制" ${state.saving?'disabled':''}></label>
          <div class="pg-leaders"><span>负责组长</span><div>${state.leaders.map(person=>`<label><input type="checkbox" data-pg-leader="${person.blacklakeOperatorId}" ${(draft.leaderIds||[]).includes(person.blacklakeOperatorId)?'checked':''} ${state.saving?'disabled':''}>${esc(person.name)}</label>`).join('')||'<small>请先在人员权限中设置8楼组长</small>'}</div><small>一键下班与定时下班按此分类内的员工执行。</small></div>
          <div class="pg-members-heading"><label for="pg-search">分类成员 <span id="pg-selected-count">${draft.blacklakeOperatorIds.length}</span> 人</label><input id="pg-search" value="${esc(state.query)}" placeholder="搜索姓名" ${state.saving?'disabled':''}></div>
          <div class="pg-member-list">${memberList()}</div>
          <div class="pg-editor-footer"><p>保存分类、成员及负责组长；工位绑定保持。</p><button class="primary-small" data-action="pg-save" ${state.saving||state.uncertain?'disabled':''}>${state.saving?'保存中…':'保存分类'}</button></div>`:'<div class="pg-empty">选择一个分类进行设置，或新增分类。</div>'}</div></div>`}
        <p class="pg-note">${state.managed?'分类已由本后台维护。':'当前显示黑湖已有分组，首次保存后由本后台维护。'} 删除分类不会删除人员，仍可从“全部”选择；“全部”不可改名或删除。</p>
        <div id="pg-confirm-host"></div>
      </section>`;
    }
    async function load({force=false}={}) {
      if(state.loading||state.saving||state.loaded&&!force)return;
      state.loading=true;state.error='';repaint();
      try { const result=await api('/v1/admin/people-groups');Object.assign(state,{...result,allPosition:result.allPosition??0,loaded:true,uncertain:false});
        if(!state.groups.some((g)=>g.id===state.selected))state.selected=state.groups[0]?.id||'';
        if(state.selected)choose(state.selected);else state.draft=null;
      } catch(error){state.error=error.message||'读取失败，请重试。';}
      finally{state.loading=false;repaint();}
    }
    function confirmAction(title,copy,onConfirm) {
      const host=document.querySelector('#pg-confirm-host');if(!host)return;
      const previous=document.activeElement;
      host.innerHTML=`<div class="pg-modal-mask"><div class="pg-modal" role="dialog" aria-modal="true" aria-labelledby="pg-confirm-title"><h3 id="pg-confirm-title">${esc(title)}</h3><p>${esc(copy)}</p><div><button class="secondary-button" id="pg-confirm-cancel">返回</button><button class="primary-small" id="pg-confirm-yes">确定</button></div></div></div>`;
      const cancel=()=>{host.replaceChildren();previous?.focus();};
      const yes=document.querySelector('#pg-confirm-yes'),back=document.querySelector('#pg-confirm-cancel');
      back.onclick=cancel;yes.onclick=()=>{host.replaceChildren();onConfirm();};back.focus();
      host.onkeydown=(e)=>{if(e.key==='Escape'){e.preventDefault();cancel();}if(e.key==='Tab'){e.preventDefault();(document.activeElement===back?yes:back).focus();}};
    }
    const ifClean=(fn)=>dirty()?confirmAction('放弃未保存的修改？','当前修改尚未保存，切换后需要重新设置。',fn):fn();
    async function save(groups,selection,{preserveDraft=false,message='人员分类已保存',allPosition=Math.min(state.allPosition,groups.length)}={}) {
      if(state.saving||state.uncertain)return;
      const draft=preserveDraft?structuredClone(state.draft):null,query=state.query;
      state.saving=true;state.error='';repaint();
      try { const result=await api('/v1/admin/people-groups',{method:'PUT',body:JSON.stringify({groups,allPosition,expectedRevision:state.revision})});
        if(!result||!Array.isArray(result.groups)||result.revision!==state.revision+1||result.groups.length!==groups.length
          ||result.allPosition!==allPosition||!groups.every((group,index)=>{const saved=result.groups[index];return saved&&(!group.id||saved.id===group.id)&&saved.name===group.name&&JSON.stringify(saved.blacklakeOperatorIds)===JSON.stringify([...new Set(group.blacklakeOperatorIds)])&&(!Object.hasOwn(group,'leaderIds')||JSON.stringify([...(saved.leaderIds||[])].sort())===JSON.stringify([...new Set(group.leaderIds)].sort()));}))throw new Error('保存回执不完整，请刷新核对分类。');
        Object.assign(state,result);state.selected=selection||result.groups.at(-1)?.id||'';
        if(preserveDraft){state.draft=draft;state.query=query;}else if(state.selected)choose(state.selected);else state.draft=null;
        notify(message);
      } catch(error){
        state.error=error.message||'保存结果未能确认，请刷新核对。';
        // A failed network response does not prove the server rejected the write.
        state.uncertain=!error.status||error.status>=500||error.status===409;
        if(state.uncertain)state.error+=' 请先刷新核对最新分类，避免覆盖其他修改。';
      } finally{state.saving=false;repaint();}
    }
    document.addEventListener('input',(event)=>{
      if(event.target.id==='pg-name'&&state.draft)state.draft.name=event.target.value;
      if(event.target.id==='pg-search'){state.query=event.target.value;const node=document.querySelector('.pg-member-list');if(node)node.innerHTML=memberList();}
    });
    document.addEventListener('change',(event)=>{
      const leader=event.target.dataset.pgLeader;if(leader&&state.draft&&!state.saving){const id=Number(leader);state.draft.leaderIds=event.target.checked?[...new Set([...(state.draft.leaderIds||[]),id])]:(state.draft.leaderIds||[]).filter(value=>value!==id);return;}
      const raw=event.target.dataset.pgMember;if(!raw||!state.draft||state.saving)return;
      const id=Number(raw);state.draft.blacklakeOperatorIds=event.target.checked?[...new Set([...state.draft.blacklakeOperatorIds,id])]:state.draft.blacklakeOperatorIds.filter((n)=>n!==id);
      const count=document.querySelector('#pg-selected-count');if(count)count.textContent=state.draft.blacklakeOperatorIds.length;
    });
    async function move(id,direction) {
      if(!state.loaded||state.loading||state.saving||state.uncertain)return;
      const list=ordered(),index=list.findIndex(group=>group.id===id),target=index+direction;
      if(index<0||target<0||target>=list.length)return;
      [list[index],list[target]]=[list[target],list[index]];
      await save(list.filter(g=>g.id!==ALL),state.selected,{preserveDraft:true,message:'分类顺序已保存',allPosition:list.findIndex(g=>g.id===ALL)});
      const button=document.querySelector(`[data-action="pg-move-${direction<0?'up':'down'}"][data-id="${id}"]`);
      (button&&!button.disabled?button:document.querySelector(`[data-action="pg-select"][data-id="${id}"]`))?.focus();
    }
    document.addEventListener('click',(event)=>{
      const button=event.target.closest('[data-action^="pg-"]');if(!button||button.disabled)return;
      const action=button.dataset.action;
      if(action==='pg-refresh')ifClean(()=>load({force:true}));
      if(action==='pg-new')ifClean(()=>{choose('new');repaint();document.querySelector('#pg-name')?.focus();});
      if(action==='pg-select')ifClean(()=>{choose(button.dataset.id);repaint();});
      if(action==='pg-move-up'||action==='pg-move-down')void move(button.dataset.id,action==='pg-move-up'?-1:1);
      if(action==='pg-save'){
        const name=state.draft?.name.normalize('NFKC').trim();
        if(!name||name.length>40||['全部','全部部门'].includes(name)||state.groups.some((g)=>g.id!==state.selected&&g.name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')===name.toLocaleLowerCase('zh-CN'))){state.error='请填写1至40字的不重复分类名称，“全部”为固定入口。';repaint();return;}
        const next={...state.draft,name};const groups=state.selected==='new'?[...state.groups,next]:state.groups.map((g)=>g.id===state.selected?next:g);
        void save(groups,state.selected==='new'?'':state.selected);
      }
      if(action==='pg-delete')confirmAction(`删除“${current()?.name}”？`,'只移除此分类及分类归属，不删除员工；员工仍可在“全部”中找到。',()=>save(state.groups.filter((g)=>g.id!==state.selected),'',{allPosition:state.allPosition-(state.groups.findIndex(g=>g.id===state.selected)<state.allPosition?1:0)}));
    });
    return {render,load};
  };
})();
