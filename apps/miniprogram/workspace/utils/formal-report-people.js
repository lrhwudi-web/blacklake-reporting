const {peopleView}=require('../../utils/report-editor-model');

// Keep the configured category order and position of “全部” in the new accordion.
module.exports=function(employees,query='',expanded=[],selectedId='',collapsed=[],config){
  const people=employees.map(person=>({...person,operatorId:String(person.id)}));
  const normalized=config&&{...config,groups:config.groups?.map(group=>({...group,operatorIds:(group.operatorIds||group.blacklakeOperatorIds||[]).map(String)}))};
  const groups=peopleView(people,normalized,'@all',query).groups,matched=new Set();
  const rows=groups.map(group=>{
    const members=peopleView(people,normalized,group.id,query).results.map(person=>{
      matched.add(person.operatorId);
      return {id:person.operatorId,name:person.name||'人员待核对',initial:(person.name||'员').slice(-1),selected:person.operatorId===String(selectedId)};
    });
    const open=query.trim()?!collapsed.includes(group.id):expanded.includes(group.id);
    return {key:group.id,name:group.name,members,count:members.length,expanded:open,height:open?members.length*48:0};
  });
  return {total:matched.size,groups:query.trim()?rows.filter(group=>group.count):rows};
};
