import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

test('正式工作台报工模块可以加载并按起止时间计算打卡时长', () => {
  const module = {exports: {}};
  const source = readFileSync(new URL('../workspace/utils/report-model.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    module,
    require(name) {
      if (name === './work-time') return {workTimeBreakdown: () => ({effectiveSeconds: 1869})};
      if (name === './formal-report-people') return () => [];
      throw new Error(`Unexpected dependency ${name}`);
    },
  });

  const {editor, editorPayload} = module.exports;
  const started = '2026-11-19T00:30:00Z';
  const ended = '2026-11-19T01:15:09Z';
  const workers = [{id: '7', name: '测试员工'}];
  const form = editor({productionWorkerId: '7', actualStartedAt: started, actualEndedAt: ended, reportedSeconds: 1869}, {workerId: '7'}, {employees: workers});
  assert.equal(form.punchMinutes, '45.15');
  const saved = editorPayload(form, workers);
  assert.equal(saved.punchMinutes, 45.15);
  assert.equal(saved.reportedSeconds, 1869);
});
