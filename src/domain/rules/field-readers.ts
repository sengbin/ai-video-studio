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
 * 读取请求载荷中的整数标识（键为 id）；缺失或不是整数时抛出校验错误。
 * @param rawInput 界面发来的原始载荷。
 * @param entityLabel 用于错误提示的对象名称，如“项目”。
 */
export function readEntityId(rawInput: unknown, entityLabel: string): number {
  const id = readRecord(rawInput).id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `${entityLabel}标识无效。` });
  }
  return id;
}

/**
 * 读取移动方向（键为 direction）：'up' 为 -1（前移），'down' 为 1（后移）；其他取值抛出校验错误。
 * @param source 提交内容。
 */
export function readMoveStep(source: Record<string, unknown>): -1 | 1 {
  if (source.direction === 'up') return -1;
  if (source.direction === 'down') return 1;
  throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '移动方向不合法。' });
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

/** 整数字段的读取要求。 */
export interface IntegerRule {
  /** 字段键。 */
  readonly key: string;
  /** 用于错误提示的字段名称。 */
  readonly label: string;
  readonly required: boolean;
  readonly min: number;
  readonly max: number;
}

/**
 * 读取整数字段：接受数字或十进制整数文本（表单以文本传输）。
 * @param source 提交内容。
 * @param rule 字段规则。
 * @param errors 累积错误的记录。
 * @returns 整数；缺省或校验失败时返回 min，错误写入 errors（非必填缺省不算错误）。
 */
export function readInteger(source: Record<string, unknown>, rule: IntegerRule, errors: FieldErrors): number {
  const value = source[rule.key];
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (value !== undefined && value !== null && typeof value !== 'number' && typeof value !== 'string') {
    errors[rule.key] = `${rule.label}必须是整数。`;
    return rule.min;
  }
  if (text === '') {
    if (rule.required) {
      errors[rule.key] = `${rule.label}不能为空。`;
    }
    return rule.min;
  }
  const parsed = /^-?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    errors[rule.key] = `${rule.label}必须是整数。`;
    return rule.min;
  }
  if (parsed < rule.min || parsed > rule.max) {
    errors[rule.key] = `${rule.label}必须在 ${rule.min} 到 ${rule.max} 之间。`;
    return rule.min;
  }
  return parsed;
}

/** 小数字段的读取要求。 */
export interface DecimalRule {
  readonly key: string;
  readonly label: string;
  /** 允许的最小值（含）。 */
  readonly min: number;
  readonly max: number;
  /** 最多保留的小数位数。 */
  readonly maxDecimals: number;
}

/**
 * 读取可选的小数字段：接受数字或十进制文本，空值返回 null。
 * @param source 提交内容。
 * @param rule 字段规则。
 * @param errors 累积错误的记录。
 */
export function readOptionalDecimal(source: Record<string, unknown>, rule: DecimalRule, errors: FieldErrors): number | null {
  const value = source[rule.key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    errors[rule.key] = `${rule.label}必须是数字。`;
    return null;
  }
  const text = String(value).trim();
  if (text === '') {
    return null;
  }
  const parsed = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  if (!Number.isFinite(parsed) || decimals > rule.maxDecimals) {
    errors[rule.key] = `${rule.label}必须是数字，最多 ${rule.maxDecimals} 位小数。`;
    return null;
  }
  if (parsed < rule.min || parsed > rule.max) {
    errors[rule.key] = `${rule.label}必须在 ${rule.min} 到 ${rule.max} 之间。`;
    return null;
  }
  return parsed;
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
