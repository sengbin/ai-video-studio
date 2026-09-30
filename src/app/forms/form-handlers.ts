// ------------------------------------------------------------------------
// 名称：form-handlers.ts
// 说明：把表单目录注册为路由请求：按名称打开表单（创建会话）、字段检查、提交、关闭。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；表单在页面内以弹出页面显示，未保存修改的确认在页面完成，宿主只维护会话。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { FormCatalog, FormDefinition, FormValues } from './form-definition';

/** 表单引擎使用的请求名称，需与 resources/form/form-runtime.js 一致。 */
export const FORM_REQUESTS = {
  open: 'form.open',
  checkField: 'form.checkField',
  submit: 'form.submit',
  close: 'form.close'
} as const;

/** 表单会话失效（已提交或已关闭）时的提示。 */
const SESSION_EXPIRED_MESSAGE = '表单已失效，请重新打开。';

/**
 * 在路由器上注册表单相关的全部请求处理函数。
 * 每次打开表单创建一个会话，后续请求带上会话标识；提交成功或关闭后会话失效。
 * @param router 页面的请求路由器。
 * @param catalog 页面可以打开的表单目录。
 */
export function registerFormHandlers(router: MessageRouter, catalog: FormCatalog): void {
  const sessions = new Map<number, FormDefinition>();
  let nextFormId = 1;

  const findSession = (payload: unknown): { formId: number; definition: FormDefinition } => {
    const formId = readRecord(payload).formId;
    const definition = typeof formId === 'number' ? sessions.get(formId) : undefined;
    if (typeof formId !== 'number' || definition === undefined) {
      throw new NotFoundError(SESSION_EXPIRED_MESSAGE);
    }
    return { formId, definition };
  };

  router.register(FORM_REQUESTS.open, (payload) => {
    const source = readRecord(payload);
    const factory = catalog.get(readString(source.form, 'form'));
    if (factory === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '不支持的表单。' });
    }
    const definition = factory(source.params);
    const formId = nextFormId++;
    sessions.set(formId, definition);
    return { formId, schema: definition.schema, values: definition.initialValues };
  });

  router.register(FORM_REQUESTS.checkField, (payload) => {
    const source = readRecord(payload);
    const key = readString(source.key, 'key');
    const value = readString(source.value, 'value');
    return { error: findSession(payload).definition.checkField?.(key, value) };
  });

  router.register(FORM_REQUESTS.submit, (payload) => {
    const { formId, definition } = findSession(payload);
    definition.submit(readFormValues(readRecord(payload).values));
    sessions.delete(formId);
    return {};
  });

  router.register(FORM_REQUESTS.close, (payload) => {
    const formId = readRecord(payload).formId;
    if (typeof formId === 'number') {
      sessions.delete(formId);
    }
    return {};
  });
}

/** 读取必须是文本的载荷字段。 */
function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `请求参数 ${name} 必须是文本。` });
  }
  return value;
}

/** 读取提交的表单值：必须是所有值都为文本的对象。 */
function readFormValues(value: unknown): FormValues {
  const record = readRecord(value);
  const values: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(record)) {
    values[key] = readString(fieldValue, key);
  }
  return values;
}
