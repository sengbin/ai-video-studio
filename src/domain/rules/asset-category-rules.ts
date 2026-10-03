// ------------------------------------------------------------------------
// 名称：asset-category-rules.ts
// 说明：资产分类的校验规则：分类名称的长度与必填。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：界面提交的内容不可信，宿主始终再校验一次；表单字段的长度约束取自这里的常量。
// ------------------------------------------------------------------------

import { FieldErrors, assertNoFieldErrors, readRecord, readText } from './field-readers';

/** 分类名称最多的字数。 */
export const ASSET_CATEGORY_NAME_MAX_LENGTH = 30;

/**
 * 读取并校验分类名称（键为 name）：去除首尾空白，必填。
 * @param rawInput 界面提交的原始内容。
 * @returns 规范化后的名称。
 * @throws ValidationError 内容不合法。
 */
export function normalizeAssetCategoryName(rawInput: unknown): string {
  const errors: FieldErrors = {};
  const name = readText(
    readRecord(rawInput),
    { key: 'name', label: '分类名称', required: true, maxLength: ASSET_CATEGORY_NAME_MAX_LENGTH },
    errors
  );
  assertNoFieldErrors(errors);
  return name;
}
