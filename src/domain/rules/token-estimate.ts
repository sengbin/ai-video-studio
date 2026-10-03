// ------------------------------------------------------------------------
// 名称：token-estimate.ts
// 说明：文本 token 数的估算：服务商没有提供计数接口时，用字符数粗略估算，用于输入预算检查。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：估算偏保守（宁可多算）：中日韩文字与全角符号约 1 个字符 1 个 token，其他字符约 3 个字符 1 个 token。
// ------------------------------------------------------------------------

/** 中日韩文字、兼容汉字与全角符号。 */
const WIDE_CHARACTER_PATTERN = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** 其他字符平均每个 token 包含的字符数。 */
const NARROW_CHARACTERS_PER_TOKEN = 3;

/**
 * 估算文本占用的 token 数。
 * @param text 待估算的文本。
 */
export function estimateTokens(text: string): number {
  const wide = text.match(WIDE_CHARACTER_PATTERN)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / NARROW_CHARACTERS_PER_TOKEN);
}
