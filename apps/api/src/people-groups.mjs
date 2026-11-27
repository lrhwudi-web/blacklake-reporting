import { createHash, randomUUID } from 'node:crypto';
import { assert } from './errors.mjs';

const key = (name) => name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
export const liReportGroupId = 'dept-836f3b4d8b271aa34e48';

export function requiresManualReportQuantity(groups, blacklakeOperatorId) {
  return groups.some(group => group.id === liReportGroupId &&
    group.blacklakeOperatorIds.includes(Number(blacklakeOperatorId)));
}

// Defaults are read-only views of upstream departments until an administrator
// explicitly saves. Once managed, deletions remain deleted on upstream refresh.
export function inheritedPeopleGroups(employees) {
  const byName = new Map();
  for (const person of employees) for (const raw of person.departments || []) {
    const name = String(raw).trim();
    if (!name || ['全部', '全部部门'].includes(key(name))) continue;
    if (!byName.has(name)) byName.set(name, { id: 'dept-' + createHash('sha256').update(name).digest('hex').slice(0,20), name, blacklakeOperatorIds: [] });
    const group = byName.get(name);
    if (!group.blacklakeOperatorIds.includes(person.blacklakeOperatorId)) group.blacklakeOperatorIds.push(person.blacklakeOperatorId);
  }
  return [...byName.values()];
}

export function validatePeopleGroups(groups, allowedIds, allowedLeaderIds = new Set()) {
  assert(Array.isArray(groups) && groups.length <= 200, 422, 'INVALID_PEOPLE_GROUPS', '最多设置200个分类。');
  const names = new Set(), ids = new Set();
  return groups.map((group) => {
    assert(group && typeof group.name === 'string', 422, 'INVALID_PEOPLE_GROUP', '请填写分类名称。');
    const name = group.name.normalize('NFKC').trim();
    assert(name.length > 0 && name.length <= 40 && !/[\x00-\x1f\x7f]/.test(name), 422, 'INVALID_PEOPLE_GROUP_NAME', '分类名称需为1至40个字符。');
    assert(!['全部','全部部门'].includes(key(name)), 422, 'RESERVED_PEOPLE_GROUP', '“全部”是固定入口，不能作为分类名称。');
    assert(!names.has(key(name)), 422, 'DUPLICATE_PEOPLE_GROUP_NAME', '分类名称重复，请修改。'); names.add(key(name));
    const id = group.id || randomUUID();
    assert(typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) && !ids.has(id), 422, 'INVALID_PEOPLE_GROUP_ID', '分类编号无效或重复，请刷新后重试。'); ids.add(id);
    assert(Array.isArray(group.blacklakeOperatorIds) && group.blacklakeOperatorIds.length <= 2000, 422, 'INVALID_PEOPLE_GROUP_MEMBERS', '请选择分类成员。');
    assert(group.blacklakeOperatorIds.every((id) => Number.isSafeInteger(id) && id > 0), 422, 'INVALID_PEOPLE_GROUP_MEMBERS', '分类成员编号无效。');
    const members = [...new Set(group.blacklakeOperatorIds)];
    assert(members.every((id) => allowedIds.has(id)), 409, 'PEOPLE_GROUP_MEMBER_UNAVAILABLE', '部分成员不在当前可派人员名单，请刷新后重试。');
    const result = { id, name, blacklakeOperatorIds: members };
    if (Object.hasOwn(group,'leaderIds')) {
      assert(Array.isArray(group.leaderIds)&&group.leaderIds.length<=100&&group.leaderIds.every(id=>Number.isSafeInteger(id)&&allowedLeaderIds.has(id)),409,'PEOPLE_GROUP_LEADER_UNAVAILABLE','部分负责组长已停用或身份变更，请刷新分类。');
      result.leaderIds=[...new Set(group.leaderIds)];
    }
    return result;
  });
}

export class PeopleGroups {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS dispatch_people_group_config (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, groups_json TEXT NOT NULL,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS dispatch_people_group_events (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, previous_json TEXT NOT NULL, next_json TEXT NOT NULL,
      actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS dispatch_people_group_leaders (
      group_id TEXT NOT NULL, leader_id INTEGER NOT NULL, PRIMARY KEY(group_id,leader_id)
    );`);
    // Keep groups_json/audit arrays compatible with older versions; position is additive.
    for (const [table, columns] of [['dispatch_people_group_config',['all_position']],['dispatch_people_group_events',['previous_all_position','next_all_position']]]) {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
      for (const column of columns) if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  read(employees = []) {
    const row = this.db.prepare('SELECT * FROM dispatch_people_group_config WHERE id=1').get();
    if (!row) return { revision: 0, managed: false, groups: inheritedPeopleGroups(employees), allPosition: 0, updatedAt: null };
    const leaders=this.db.prepare('SELECT group_id,leader_id FROM dispatch_people_group_leaders').all();
    const groups = JSON.parse(row.groups_json).map(group=>{
      const ids=leaders.filter(item=>item.group_id===group.id).map(item=>item.leader_id);
      return ids.length?{...group,leaderIds:ids}:group;
    });
    return { revision: row.revision, managed: true, groups, allPosition: Math.min(row.all_position,groups.length), updatedAt: row.updated_at };
  }
  apply(employees) {
    const config = this.read(employees);
    if (!config.managed) return employees;
    return employees.map((person) => ({ ...person, departments: config.groups.filter((group) => group.blacklakeOperatorIds.includes(person.blacklakeOperatorId)).map((group) => group.name) }));
  }
  save(groups, expectedRevision, actor, defaults = [], {allPosition} = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.read(defaults);
      assert(before.revision === expectedRevision, 409, 'PEOPLE_GROUPS_CHANGED', '分类已被其他管理员修改，请刷新后重试。');
      const position = allPosition === undefined ? Math.min(before.allPosition,groups.length) : allPosition;
      assert(Number.isSafeInteger(position) && position >= 0 && position <= groups.length,422,'INVALID_PEOPLE_ALL_POSITION','“全部”的显示位置无效，请刷新后重试。');
      const revision = before.revision + 1;
      // Keep the legacy category JSON shape; leader authority is additive and separately stored.
      for(const group of groups)if(Object.hasOwn(group,'leaderIds')){
        this.db.prepare('DELETE FROM dispatch_people_group_leaders WHERE group_id=?').run(group.id);
        for(const id of group.leaderIds)this.db.prepare('INSERT INTO dispatch_people_group_leaders(group_id,leader_id) VALUES(?,?)').run(group.id,id);
      }
      for(const row of this.db.prepare('SELECT DISTINCT group_id FROM dispatch_people_group_leaders').all())if(!groups.some(group=>group.id===row.group_id))this.db.prepare('DELETE FROM dispatch_people_group_leaders WHERE group_id=?').run(row.group_id);
      const stored=groups.map(({leaderIds,...group})=>group);
      this.db.prepare(`INSERT INTO dispatch_people_group_config (id,revision,groups_json,updated_by,all_position) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,groups_json=excluded.groups_json,updated_by=excluded.updated_by,all_position=excluded.all_position,updated_at=CURRENT_TIMESTAMP`).run(revision, JSON.stringify(stored), actor, position);
      this.db.prepare('INSERT INTO dispatch_people_group_events (id,revision,previous_json,next_json,actor,previous_all_position,next_all_position) VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), revision, JSON.stringify(before.groups), JSON.stringify(groups), actor, before.allPosition, position);
      this.db.exec('COMMIT');return this.read();
    } catch (error) { this.db.exec('ROLLBACK');throw error; }
  }
}
