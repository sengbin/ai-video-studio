// ------------------------------------------------------------------------
// 名称：error-mapping.ts
// 说明：把领域错误和未知异常转换为可发给界面的错误载荷。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：未知异常只向界面暴露简短说明，完整信息记录到控制台。
// ------------------------------------------------------------------------

import { ConflictError, FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ErrorPayload } from './envelope';

/** 未知异常对界面展示的固定前缀。 */
const UNEXPECTED_ERROR_PREFIX = '操作失败，请重试。';

/**
 * 把异常转换为错误载荷。
 * @param error 处理请求时抛出的任意值。
 */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof ValidationError) {
    return { kind: 'validation', message: error.message, fieldErrors: error.fieldErrors };
  }
  if (error instanceof ConflictError) {
    return { kind: 'conflict', message: error.message, fieldErrors: { [error.field]: error.message } };
  }
  if (error instanceof NotFoundError) {
    return { kind: 'not-found', message: error.message, fieldErrors: { [FORM_LEVEL_ERROR_KEY]: error.message } };
  }

  console.error('处理界面请求时出现未预期的错误：', error);
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: 'unexpected', message: `${UNEXPECTED_ERROR_PREFIX}（${detail}）` };
}
