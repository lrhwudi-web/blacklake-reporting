function canChoose(employee) { return Boolean(employee && (employee.available || employee.canQueue)); }
function groups(employees, config) {
  const make=(id,label,ids,isAll=false)=>{
    const allowed=new Set(ids.map(String)),memberIds=employees.filter(person=>isAll||allowed.has(String(person.blacklakeOperatorId))).map(person=>String(person.blacklakeOperatorId));
    return {id,label,isAll,memberIds,count:memberIds.length};
  };
  const all=make('@all','全部',[],true);
  let rows;
  if(config&&Array.isArray(config.groups)){
    rows=config.groups.map(group=>make(String(group.id),group.name,group.blacklakeOperatorIds||group.operatorIds||employees.filter(p=>(p.departments||[]).includes(group.name)).map(p=>p.blacklakeOperatorId)));
    const position=Number.isInteger(config.allPosition)?Math.max(0,Math.min(config.allPosition,rows.length)):0;rows.splice(position,0,all);
  }else{
    const names=[...new Set(employees.flatMap(employee=>employee.departments||[]))];
    rows=[all,...names.map(name=>make('dept:'+name,name,employees.filter(p=>(p.departments||[]).includes(name)).map(p=>p.blacklakeOperatorId)))];
  }
  return rows.map((row,index)=>({...row,index}));
}
function placements(employees, selectedIds, manual, units) {
  return selectedIds.map(id => {
    const employee = employees.find(row => row.blacklakeOperatorId === id);
    const bindings = employee?.boundUnitIds || [];
    const unitId = manual[id] || (bindings.length === 1 ? bindings[0] : '');
    return { blacklakeOperatorId: id, name: employee?.name || '人员待核对', unitId,
      unitLabel: unitId || (bindings.length > 1 ? '绑定多个工位，请选择' : '请选择工位'),
      source: manual[id] ? 'manual' : 'binding', unitIndex: Math.max(0, units.findIndex(unit => unit.id === unitId) + 1) };
  });
}
module.exports = { canChoose, groups, placements };
