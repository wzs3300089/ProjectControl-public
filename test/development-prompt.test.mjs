import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as prompts from '../src/console/shared/prompt.js';

const workspace = { id: 'ws-development', name: '订单平台', modules: ['结算'] };
const requirement = {
  id: 'req-checkout', workspaceId: workspace.id, name: '订单幂等提交', module: '结算',
  summary: '重复提交返回同一订单。\n失败后允许安全重试。', link: 'https://example.test/spec', tags: ['接口兼容'],
  progress: 35, status: '状态占位值', owner: '负责人占位值',
  startedOn: '2091-01-01', dueDate: '2091-02-01', createdAt: '2091-01-01T00:00:00Z', updatedAt: '2091-01-02T00:00:00Z',
  updates: Array.from({ length: 22 }, (_, index) => ({
    id: `log-${index}`, at: `2091-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    kind: index === 0 ? 'decision' : 'progress', text: index === 0 ? '旧决策：兼容现有请求键' : `已验证分支 ${index}`,
  })),
  todos: [
    { id: 'todo-retry', title: '验证并发重试', done: false, owner: '待办负责人占位值', dueDate: '2091-02-02' },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `done-${index}`, title: `已完成步骤 ${index}`, done: true, doneAt: '2091-01-03T00:00:00Z',
    })),
  ],
};

test('开发消息只携带当前需求的开发内容及稳定标识，不泄漏管理字段或截掉旧决策', () => {
  assert.equal(typeof prompts.buildDevelopmentPrompt, 'function');
  const before = structuredClone(requirement);
  const text = prompts.buildDevelopmentPrompt({ project: requirement, workspace });
  for (const value of [workspace.name, workspace.id, requirement.id, requirement.name, requirement.module,
    requirement.summary, requirement.link, '接口兼容', '35%', '旧决策：兼容现有请求键', '已验证分支 21',
    'todo-retry', '验证并发重试', '已完成步骤 11']) assert.ok(text.includes(value), `缺少 ${value}`);
  for (const value of ['状态占位值', '负责人占位值', '待办负责人占位值', '2091-', '剩余天数', '时间风险']) {
    assert.ok(!text.includes(value), `不应携带 ${value}`);
  }
  assert.ok(text.indexOf('已验证分支 21') < text.indexOf('旧决策：兼容现有请求键'));
  assert.deepEqual(requirement, before);
});

test('开发消息保留缺失说明的事实，不编造内容', () => {
  assert.equal(typeof prompts.buildDevelopmentPrompt, 'function');
  const text = prompts.buildDevelopmentPrompt({ project: { id: 'empty', workspaceId: workspace.id, name: '空需求' }, workspace });
  assert.ok(text.includes('空需求'));
  assert.match(text, /未填写/);
  assert.match(text, /暂无/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test('缺失稳定标识或跨项目需求不能生成开发消息，避免回写错位', () => {
  assert.equal(typeof prompts.buildDevelopmentPrompt, 'function');
  for (const options of [
    { project: null, workspace },
    { project: { ...requirement, id: '' }, workspace },
    { project: requirement, workspace: null },
    { project: requirement, workspace: { ...workspace, id: 'another-workspace' } },
  ]) assert.throws(() => prompts.buildDevelopmentPrompt(options), /需求|项目/);
});
