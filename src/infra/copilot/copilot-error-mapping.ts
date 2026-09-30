// ------------------------------------------------------------------------
// 名称：copilot-error-mapping.ts
// 说明：把调用 vscode.lm 时抛出的错误转换为领域层的 TextGenerationError。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不导入 vscode，按错误的 name、code 与消息判断，便于在测试中直接验证。
// ------------------------------------------------------------------------

import { TextGenerationError } from '../../domain/errors';

const RATE_LIMIT_PATTERN = /rate.?limit|quota|too many requests|\b429\b/i;

/** 读取对象上的文本属性，不存在时返回空串。 */
function readString(source: unknown, key: string): string {
  if (typeof source === 'object' && source !== null && key in source) {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * 转换调用语言模型失败时的错误。
 * @param error 捕获到的任意错误。
 * @returns 带分类的错误，界面据此决定提示与是否值得重试。
 */
export function mapLanguageModelError(error: unknown): TextGenerationError {
  if (error instanceof TextGenerationError) {
    return error;
  }
  const name = readString(error, 'name');
  const code = readString(error, 'code');
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'Canceled' || name === 'AbortError' || code === 'Canceled') {
    return new TextGenerationError('canceled', '已取消。', { cause: error });
  }
  switch (code) {
    case 'NoPermissions':
      return new TextGenerationError('not_authorized', '未获得使用 Copilot 模型的授权，请在授权提示中允许后重试。', { cause: error });
    case 'Blocked':
      return new TextGenerationError('rate_limited', '请求被阻止：可能是 Copilot 配额已用完、被限流或内容被拦截，请稍后重试。', {
        cause: error
      });
    case 'NotFound':
      return new TextGenerationError('unavailable', '所选 Copilot 模型不存在或已不可用，请在设置中更换模型。', { cause: error });
    default: {
      const detail = `${message} ${readString((error as { cause?: unknown } | null)?.cause, 'message')}`;
      if (RATE_LIMIT_PATTERN.test(detail)) {
        return new TextGenerationError('rate_limited', '请求过于频繁或配额已用完，请稍后重试。', { cause: error });
      }
      return new TextGenerationError('failed', `调用 Copilot 失败：${message}`, { cause: error });
    }
  }
}
