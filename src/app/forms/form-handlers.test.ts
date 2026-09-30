// ------------------------------------------------------------------------
// 名称：form-handlers.test.ts
// 说明：表单请求处理的自动化测试：初始化、字段检查、提交、取消与放弃确认。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../../domain/errors';
import { MessageRouter } from '../messaging/message-router';
import { FormDefinition, FormValues } from './form-definition';
import { FORM_REQUESTS, FormHandlerHooks, registerFormHandlers } from './form-handlers';

/** 记录钩子被调用情况的测试夹具。 */
function createFixture(options: { discardConfirmed?: boolean; submit?: (values: FormValues) => void } = {}) {
  const calls = { submitted: 0, cancelled: 0, confirmAsked: 0, submittedValues: [] as FormValues[] };
  const definition: FormDefinition = {
    schema: {
      title: '新建项目',
      submitLabel: '保存',
      fields: [{ key: 'name', label: '项目名称', description: '项目的名称', control: 'text', required: true }]
    },
    initialValues: { name: '' },
    checkField: (key, value) => (key === 'name' && value === '重名' ? '已存在同名项目。' : undefined),
    submit: options.submit ?? ((values) => calls.submittedValues.push(values))
  };
  const hooks: FormHandlerHooks = {
    onSubmitted: () => {
      calls.submitted += 1;
    },
    confirmDiscard: async () => {
      calls.confirmAsked += 1;
      return options.discardConfirmed ?? false;
    },
    onCancelled: () => {
      calls.cancelled += 1;
    }
  };
  const router = new MessageRouter();
  registerFormHandlers(router, definition, hooks);
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { calls, send };
}

test('初始化返回表单结构和初始值', async () => {
  const { send } = createFixture();
  const response = await send(FORM_REQUESTS.init);
  assert.ok(response?.ok);
  const data = response.data as { schema: { title: string }; values: FormValues };
  assert.equal(data.schema.title, '新建项目');
  assert.deepEqual(data.values, { name: '' });
});

test('字段检查返回服务端错误，没有问题时为 undefined', async () => {
  const { send } = createFixture();
  const conflict = await send(FORM_REQUESTS.checkField, { key: 'name', value: '重名' });
  assert.deepEqual(conflict?.ok && conflict.data, { error: '已存在同名项目。' });
  const available = await send(FORM_REQUESTS.checkField, { key: 'name', value: '新名字' });
  assert.deepEqual(available?.ok && available.data, { error: undefined });
});

test('字段检查拒绝非文本参数', async () => {
  const { send } = createFixture();
  const response = await send(FORM_REQUESTS.checkField, { key: 'name', value: 5 });
  assert.ok(response && !response.ok && response.error.kind === 'validation');
});

test('提交成功：调用定义的提交并触发已提交钩子', async () => {
  const { send, calls } = createFixture();
  const response = await send(FORM_REQUESTS.submit, { values: { name: '灯塔' } });
  assert.ok(response?.ok);
  assert.deepEqual(calls.submittedValues, [{ name: '灯塔' }]);
  assert.equal(calls.submitted, 1);
});

test('提交失败：不触发已提交钩子，错误按类型返回', async () => {
  const { send, calls } = createFixture({
    submit: () => {
      throw new ValidationError({ name: '项目名称不能为空。' });
    }
  });
  const response = await send(FORM_REQUESTS.submit, { values: { name: '' } });
  assert.ok(response && !response.ok && response.error.kind === 'validation');
  assert.equal(calls.submitted, 0);
});

test('提交拒绝非文本的字段值和缺失的 values', async () => {
  const { send, calls } = createFixture();
  const notText = await send(FORM_REQUESTS.submit, { values: { name: 1 } });
  assert.ok(notText && !notText.ok);
  const missing = await send(FORM_REQUESTS.submit, {});
  assert.ok(missing && !missing.ok);
  assert.equal(calls.submitted, 0);
});

test('取消：没有修改时直接关闭，不询问', async () => {
  const { send, calls } = createFixture();
  const response = await send(FORM_REQUESTS.cancel, { dirty: false });
  assert.deepEqual(response?.ok && response.data, { closed: true });
  assert.equal(calls.confirmAsked, 0);
  assert.equal(calls.cancelled, 1);
});

test('取消：有修改且用户确认放弃时关闭', async () => {
  const { send, calls } = createFixture({ discardConfirmed: true });
  const response = await send(FORM_REQUESTS.cancel, { dirty: true });
  assert.deepEqual(response?.ok && response.data, { closed: true });
  assert.equal(calls.confirmAsked, 1);
  assert.equal(calls.cancelled, 1);
});

test('取消：有修改但用户不放弃时保持打开', async () => {
  const { send, calls } = createFixture({ discardConfirmed: false });
  const response = await send(FORM_REQUESTS.cancel, { dirty: true });
  assert.deepEqual(response?.ok && response.data, { closed: false });
  assert.equal(calls.cancelled, 0);
});
