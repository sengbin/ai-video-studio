// ------------------------------------------------------------------------
// 名称：field-readers.ts
// 说明：读取并校验来自界面的未知类型字段：文本和选项，错误累积到同一个记录中。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：界面提交的内容不可信，所有表单规则都通过这里读取字段。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';

/** 累积字段错误的记录，键为字段键。 */
export type FieldErrors = Record<string, string>;

/** 文本字段的读取要求。 */
export interface TextRule {
  /** 字段键。 */
  readonly key: string;
  /** 用于错误提示的字段名称。 */
  readonly label: string;
  readonly required: boolean;
  readonly maxLength: number;
}

/**
 * 把未知输入转换为对象；不是对象时抛出校验错误。
 * @param rawInput 界面提交的原始内容。
 */
export function readRecord(rawInput: unknown): Record<string, unknown> {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '提交内容格式不正确。' });
  }
  return rawInput as Record<string, unknown>;
}

/**
 * 读取文本字段：去除首尾空白，校验必填与长度；缺省或空值按空串处理。
 * @param source 提交内容。
 * @param rule 字段规则。
 * @param errors 累积错误的记录。
 * @returns 规范化后的文本；校验失败时返回已读取到的文本，错误写入 errors。
 */
export function readText(source: Record<string, unknown>, rule: TextRule, errors: FieldErrors): string {
  const value = source[rule.key];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    errors[rule.key] = `${rule.label}必须是文本。`;
    return '';
  }

  const text = (value ?? '').trim();
  if (text.length === 0 && rule.required) {
    errors[rule.key] = `${rule.label}不能为空。`;
  } else if (text.length > rule.maxLength) {
    errors[rule.key] = `${rule.label}不能超过 ${rule.maxLength} 字（当前 ${text.length} 字）。`;
  }
  return text;
}

/**
 * 读取可选的自由文本字段：空值返回 null。
 * @param source 提交内容。
 * @param rule 字段规则，required 应为 false。
 * @param errors 累积错误的记录。
 */
export function readOptionalText(source: Record<string, unknown>, rule: TextRule, errors: FieldErrors): string | null {
  const text = readText(source, rule, errors);
  return text.length === 0 ? null : text;
}

/**
 * 读取必须取自给定选项的可选字段：空值返回 null，不在选项内时记录错误。
 * @param source 提交内容。
 * @param key 字段键。
 * @param label 用于错误提示的字段名称。
 * @param options 允许的取值。
 * @param errors 累积错误的记录。
 */
export function readOptionalChoice(
  source: Record<string, unknown>,
  key: string,
  label: string,
  options: readonly string[],
  errors: FieldErrors
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !options.includes(value)) {
    errors[key] = `${label}必须是以下之一：${options.join('、')}。`;
    return null;
  }
  return value;
}

/**
 * 存在字段错误时抛出校验错误。
 * @param errors 累积错误的记录。
 */
export function assertNoFieldErrors(errors: FieldErrors): void {
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
}
