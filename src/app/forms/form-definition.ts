// ------------------------------------------------------------------------
// 名称：form-definition.ts
// 说明：表单定义的类型：字段描述、初始值、字段检查与提交，以及按名称登记表单的目录。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；页面通过表单名称与参数向宿主请求打开表单，宿主用目录中的工厂创建定义。
// ------------------------------------------------------------------------

import { FormSchema } from './form-schema';

/** 表单提交的值：字段键到文本。 */
export type FormValues = Readonly<Record<string, string>>;

/**
 * 表单动作：根据当前字段值异步计算需要回填的字段值，不改变会话状态。
 * @param values 表单当前值。
 * @param signal 取消信号，用户点“取消”或关闭表单时触发。
 * @returns 字段键到新值。
 * @throws ValidationError、TextGenerationError 等领域错误。
 */
export type FormAction = (values: FormValues, signal: AbortSignal) => Promise<FormValues>;

/** 一个具体表单的定义。 */
export interface FormDefinition {
  readonly schema: FormSchema;
  /** 表单初始值；新建时通常为空，编辑时为已有内容。 */
  readonly initialValues: FormValues;
  /**
   * 字段失去焦点时的服务端检查，如名称唯一性。
   * @returns 错误提示；没有问题返回 undefined。
   */
  checkField?(key: string, value: string): string | undefined;
  /** 字段动作，键与 schema.actions 一致。 */
  readonly actions?: Readonly<Record<string, FormAction>>;
  /**
   * 提交表单，可以是异步的（例如需要先确认 Copilot 可用）；完成前表单会话保持有效。
   * @param submitKey 所点提交按钮的键（schema.submitActions）；只有一个提交按钮时为空串。
   * @throws ValidationError、ConflictError 等领域错误。
   */
  submit(values: FormValues, submitKey?: string): void | Promise<void>;
}

/**
 * 表单工厂：按页面传来的参数创建表单定义。
 * @throws ValidationError、NotFoundError 参数无效或对象不存在。
 */
export type FormFactory = (params: unknown) => FormDefinition;

/**
 * 异步表单工厂：创建定义时需要查询异步数据（如可用模型）的表单使用。
 * @throws ValidationError、NotFoundError 参数无效或对象不存在。
 */
export type AsyncFormFactory = (params: unknown) => Promise<FormDefinition>;

/** 只含同步工厂的表单目录，如 `project.create`。 */
export type SyncFormCatalog = ReadonlyMap<string, FormFactory>;

/** 表单目录：表单名称到工厂；页面处理按 await 统一创建，同步与异步工厂可以混合。 */
export type FormCatalog = ReadonlyMap<string, FormFactory | AsyncFormFactory>;
