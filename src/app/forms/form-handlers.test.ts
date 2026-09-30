// ------------------------------------------------------------------------
// 名称：form-handlers.test.ts
// 说明：表单请求处理的自动化测试：按名称打开、字段检查、提交与关闭，以及会话失效。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../../domain/errors';
import { MessageRouter } from '../messaging/message-router';
import { FormCatalog, FormDefinition, FormValues } from './form-definition';
import { FORM_REQUESTS, registerFormHandlers } from './form-handlers';

/** 创建路由器与一个名为 `demo` 的表单；返回提交记录与发送请求的函数。 */
function createFixture(options: { submit?: (values: FormValues) => void } = {}) {
  const submittedValues: FormValues[] = [];
  const openedParams: unknown[] = [];
  const catalog: FormCatalog = new Map([
    [
      'demo',
      (params): FormDefinition => {
        openedParams.push(params);
        return {
          schema: {
            title: '新建项目',
            submitLabel: '保存',
            fields: [{ key: 'name', label: '项目名称', description: '项目的名称', control: 'text', required: true }]
          },
          initialValues: { name: '' },
          checkField: (key, value) => (key === 'name' && value === '重名' ? '已存在同名项目。' : undefined),
          submit: options.submit ?? ((values) => submittedValues.push(values))
        };
      }
    ]
  ]);
  const router = new MessageRouter();
  registerFormHandlers(router, catalog);
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  /** 打开 demo 表单并返回会话标识。 */
  const open = async (params?: unknown): Promise<number> => {
    const response = await send(FORM_REQUESTS.open, { form: 'demo', params });
    assert.ok(response?.ok);
    return (response.data as { formId: number }).formId;
  };
  return { submittedValues, openedParams, send, open };
}

test('打开表单：返回会话标识、表单结构和初始值，并把参数交给工厂', async () => {
  const { send, openedParams } = createFixture();
  const response = await send(FORM_REQUESTS.open, { form: 'demo', params: { id: 3 } });
  assert.ok(response?.ok);
  const data = response.data as { formId: number; schema: { title: string }; values: FormValues };
  assert.equal(typeof data.formId, 'number');
  assert.equal(data.schema.title, '新建项目');
  assert.deepEqual(data.values, { name: '' });
  assert.deepEqual(openedParams, [{ id: 3 }]);
});

test('打开表单：每次打开都是独立会话；未登记的表单名或非文本名称被拒绝', async () => {
  const { send, open } = createFixture();
  assert.notEqual(await open(), await open());

  const unknown = await send(FORM_REQUESTS.open, { form: 'missing' });
  assert.ok(unknown && !unknown.ok && unknown.error.kind === 'validation');
  const notText = await send(FORM_REQUESTS.open, { form: 5 });
  assert.ok(notText && !notText.ok && notText.error.kind === 'validation');
  const constructorName = await send(FORM_REQUESTS.open, { form: 'constructor' });
  assert.ok(constructorName && !constructorName.ok, '原型上的属性名不应被当作表单');
});

test('字段检查返回服务端错误，没有问题时为 undefined', async () => {
  const { send, open } = createFixture();
  const formId = await open();
  const conflict = await send(FORM_REQUESTS.checkField, { formId, key: 'name', value: '重名' });
  assert.deepEqual(conflict?.ok && conflict.data, { error: '已存在同名项目。' });
  const available = await send(FORM_REQUESTS.checkField, { formId, key: 'name', value: '新名字' });
  assert.deepEqual(available?.ok && available.data, { error: undefined });
});

test('字段检查拒绝非文本参数', async () => {
  const { send, open } = createFixture();
  const formId = await open();
  const response = await send(FORM_REQUESTS.checkField, { formId, key: 'name', value: 5 });
  assert.ok(response && !response.ok && response.error.kind === 'validation');
});

test('提交成功：调用定义的提交，会话随即失效', async () => {
  const { send, open, submittedValues } = createFixture();
  const formId = await open();
  const response = await send(FORM_REQUESTS.submit, { formId, values: { name: '灯塔' } });
  assert.ok(response?.ok);
  assert.deepEqual(submittedValues, [{ name: '灯塔' }]);

  const again = await send(FORM_REQUESTS.submit, { formId, values: { name: '再来' } });
  assert.ok(again && !again.ok && again.error.kind === 'not-found');
  assert.equal(submittedValues.length, 1);
});

test('提交失败：错误按类型返回，会话保留以便修改后重新提交', async () => {
  let shouldFail = true;
  const submitted: FormValues[] = [];
  const { send, open } = createFixture({
    submit: (values) => {
      if (shouldFail) throw new ValidationError({ name: '项目名称不能为空。' });
      submitted.push(values);
    }
  });
  const formId = await open();
  const failed = await send(FORM_REQUESTS.submit, { formId, values: { name: '' } });
  assert.ok(failed && !failed.ok && failed.error.kind === 'validation');

  shouldFail = false;
  const retried = await send(FORM_REQUESTS.submit, { formId, values: { name: '灯塔' } });
  assert.ok(retried?.ok);
  assert.deepEqual(submitted, [{ name: '灯塔' }]);
});

test('提交拒绝非文本的字段值和缺失的 values', async () => {
  const { send, open, submittedValues } = createFixture();
  const formId = await open();
  const notText = await send(FORM_REQUESTS.submit, { formId, values: { name: 1 } });
  assert.ok(notText && !notText.ok);
  const missing = await send(FORM_REQUESTS.submit, { formId });
  assert.ok(missing && !missing.ok);
  assert.equal(submittedValues.length, 0);
});

test('关闭：会话失效，之后的检查与提交返回不存在；重复关闭或未知会话也不报错', async () => {
  const { send, open } = createFixture();
  const formId = await open();
  assert.ok((await send(FORM_REQUESTS.close, { formId }))?.ok);
  assert.ok((await send(FORM_REQUESTS.close, { formId }))?.ok);
  assert.ok((await send(FORM_REQUESTS.close, { formId: 999 }))?.ok);

  const check = await send(FORM_REQUESTS.checkField, { formId, key: 'name', value: 'x' });
  assert.ok(check && !check.ok && check.error.kind === 'not-found');
  const submit = await send(FORM_REQUESTS.submit, { formId, values: { name: 'x' } });
  assert.ok(submit && !submit.ok && submit.error.kind === 'not-found');
});

test('检查与提交需要有效的会话标识', async () => {
  const { send } = createFixture();
  const payloads = [
    { key: 'name', value: 'x' },
    { formId: '1', key: 'name', value: 'x' },
    { formId: 42, key: 'name', value: 'x' }
  ];
  for (const payload of payloads) {
    const response = await send(FORM_REQUESTS.checkField, payload);
    assert.ok(response && !response.ok && response.error.kind === 'not-found', `载荷 ${JSON.stringify(payload)} 应被拒绝`);
  }
});
