// ------------------------------------------------------------------------
// 名称：form-handlers.ts
// 说明：把表单定义注册为路由请求：初始化、字段检查、提交、取消。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；关闭面板等行为通过 hooks 注入。未保存修改的确认由页面内对话框完成，宿主只负责关闭。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { FormDefinition, FormValues } from './form-definition';

/** 表单引擎使用的请求名称，需与 resources/form/form-runtime.js 一致。 */
export const FORM_REQUESTS = {
  init: 'form.init',
  checkField: 'form.checkField',
  submit: 'form.submit',
  cancel: 'form.cancel'
} as const;

/** 表单生命周期中需要外部完成的动作。 */
export interface FormHandlerHooks {
  /** 提交成功后调用，通常用于关闭面板并刷新来源页。 */
  onSubmitted(): void;
  /** 用户取消（页面已完成放弃确认）后调用，通常用于关闭面板。 */
  onCancelled(): void;
}

/**
 * 在路由器上注册表单的全部请求处理函数。
 * @param router 面板的请求路由器。
 * @param definition 表单定义。
 * @param hooks 生命周期动作。
 */
export function registerFormHandlers(router: MessageRouter, definition: FormDefinition, hooks: FormHandlerHooks): void {
  router.register(FORM_REQUESTS.init, () => ({ schema: definition.schema, values: definition.initialValues }));

  router.register(FORM_REQUESTS.checkField, (payload) => {
    const source = readRecord(payload);
    const key = readString(source.key, 'key');
    const value = readString(source.value, 'value');
    return { error: definition.checkField?.(key, value) };
  });

  router.register(FORM_REQUESTS.submit, (payload) => {
    const values = readFormValues(readRecord(payload).values);
    definition.submit(values);
    hooks.onSubmitted();
    return {};
  });

  router.register(FORM_REQUESTS.cancel, () => {
    hooks.onCancelled();
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
