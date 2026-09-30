// ------------------------------------------------------------------------
// 名称：errors.ts
// 说明：领域层统一的错误类型：校验失败、记录不存在、名称冲突。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：界面按错误类型决定展示方式，字段级错误用字段键定位。
// ------------------------------------------------------------------------

/** 表单级错误使用的字段键，表示不属于某个具体字段。 */
export const FORM_LEVEL_ERROR_KEY = '';

/** 提交内容不符合约定；fieldErrors 以字段键为键、修正提示为值。 */
export class ValidationError extends Error {
  constructor(readonly fieldErrors: Readonly<Record<string, string>>) {
    super(Object.values(fieldErrors).join('；'));
    this.name = 'ValidationError';
  }
}

/** 按标识找不到对应记录。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 违反唯一性约束，例如名称重复；field 指出冲突的字段键。 */
export class ConflictError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 文本生成失败的分类：不可用、未授权、限流、被拒绝、已取消、其他。 */
export type TextGenerationFailure =
  | 'unavailable'
  | 'not_authorized'
  | 'rate_limited'
  | 'refused'
  | 'canceled'
  | 'failed';

/** 调用文本生成服务（Copilot）失败；category 决定界面提示与是否值得重试。 */
export class TextGenerationError extends Error {
  constructor(readonly category: TextGenerationFailure, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'TextGenerationError';
  }
}

/** 模型返回的内容不符合约定的格式或规则；issues 逐条说明问题，可原样反馈给模型让它修正。 */
export class GeneratedOutputError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join('；'));
    this.name = 'GeneratedOutputError';
  }
}
