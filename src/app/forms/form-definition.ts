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
   * 提交表单，可以是异步的（例如需要先确认 Copilot 可用）；完成前表单会话保持有效。
   * @throws ValidationError、ConflictError 等领域错误。
   */
  submit(values: FormValues): void | Promise<void>;
}

/**
 * 表单工厂：按页面传来的参数创建表单定义。
 * @throws ValidationError、NotFoundError 参数无效或对象不存在。
 */
export type FormFactory = (params: unknown) => FormDefinition;

/** 表单目录：表单名称到工厂，如 `project.create`。 */
export type FormCatalog = ReadonlyMap<string, FormFactory>;
