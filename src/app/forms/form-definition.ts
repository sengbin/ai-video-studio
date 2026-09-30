// ------------------------------------------------------------------------
// 名称：form-definition.ts
// 说明：表单定义：结构描述、初始值以及提交和字段检查的行为，由具体表单实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：提交失败时抛出领域错误，由消息路由转换为界面可展示的错误。
// ------------------------------------------------------------------------

import { FormSchema } from './form-schema';

/** 表单提交的值：字段键到文本。 */
export type FormValues = Readonly<Record<string, string>>;

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
  /**
   * 提交表单。
   * @throws ValidationError、ConflictError 等领域错误。
   */
  submit(values: FormValues): void;
}
