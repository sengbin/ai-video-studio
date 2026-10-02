// ------------------------------------------------------------------------
// 名称：provider-rules.ts
// 说明：服务商设置页提交内容的规则：服务商启用与设置项、访问密钥、模型启用的读取与校验，以及设置默认值合并和密钥名称。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：界面提交的内容不可信；设置项按适配器声明校验，未声明的键一律拒绝。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { ProviderSettingField, ProviderSettings } from '../models/model-provider';
import { FieldErrors, assertNoFieldErrors, readRecord } from './field-readers';

/** 访问密钥的最大长度。 */
export const API_KEY_MAX_LENGTH = 500;

/** 设置项文本值的最大长度。 */
export const SETTING_VALUE_MAX_LENGTH = 300;

/** 访问密钥在密钥存储中的名称前缀。 */
const API_KEY_SECRET_PREFIX = 'aiVideoStudio.provider';

/** 密钥字段的字段键，用于错误定位。 */
export const API_KEY_FIELD_KEY = 'apiKey';

/**
 * 服务商访问密钥在密钥存储中的名称。
 * @param providerCode 服务商代码。
 */
export function providerApiKeySecretKey(providerCode: string): string {
  return `${API_KEY_SECRET_PREFIX}.${providerCode}.apiKey`;
}

/**
 * 用声明的默认值补全已保存的设置：未保存过的项取默认值，不再声明的旧键丢弃。
 * @param fields 适配器声明的设置项。
 * @param stored 数据库中保存的设置。
 */
export function resolveProviderSettings(fields: readonly ProviderSettingField[], stored: ProviderSettings): ProviderSettings {
  return Object.fromEntries(fields.map((field) => [field.key, stored[field.key] ?? field.defaultValue]));
}

/** 读取请求载荷中的整数标识；缺失或不是整数时抛出校验错误。 */
function readIdentifier(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `${label}标识无效。` });
  }
  return value;
}

/** 服务商修改请求中未经设置项校验的部分。 */
export interface ProviderUpdateInput {
  readonly providerId: number;
  readonly isEnabled?: boolean;
  /** 要修改的设置项，值的类型未知，需按设置项声明校验。 */
  readonly rawSettings?: Record<string, unknown>;
}

/**
 * 读取服务商修改请求：服务商标识必填，启用状态与设置项至少提供一项。
 * @param rawInput 界面提交的原始内容。
 * @throws ValidationError 内容不合法。
 */
export function readProviderUpdate(rawInput: unknown): ProviderUpdateInput {
  const source = readRecord(rawInput);
  const providerId = readIdentifier(source, 'providerId', '服务商');
  const { isEnabled, settings } = source;
  if (isEnabled !== undefined && typeof isEnabled !== 'boolean') {
    throw new ValidationError({ isEnabled: '启用状态必须是开或关。' });
  }
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '设置内容格式不正确。' });
  }
  if (isEnabled === undefined && settings === undefined) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有需要保存的内容。' });
  }
  return { providerId, isEnabled, rawSettings: settings as Record<string, unknown> | undefined };
}

/**
 * 按声明校验并规范化要修改的设置项：文本去除首尾空白，https 地址去除末尾斜杠，下拉必须取自选项。
 * @param rawSettings 界面提交的设置项，只处理出现的键。
 * @param fields 适配器声明的设置项。
 * @returns 规范化后的设置项（只含出现的键）。
 * @throws ValidationError 存在未声明的键或不合法的值，错误以设置键定位。
 */
export function normalizeProviderSettings(rawSettings: Record<string, unknown>, fields: readonly ProviderSettingField[]): ProviderSettings {
  const errors: FieldErrors = {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawSettings)) {
    const field = fields.find((candidate) => candidate.key === key);
    if (field === undefined) {
      errors[key] = '不支持的设置项。';
      continue;
    }
    const message = readSettingValue(field, value, result);
    if (message !== null) {
      errors[key] = message;
    }
  }
  assertNoFieldErrors(errors);
  return result;
}

/** 校验一个设置项的值，通过时写入 target 并返回 null，否则返回错误提示。 */
function readSettingValue(field: ProviderSettingField, value: unknown, target: Record<string, string>): string | null {
  if (typeof value !== 'string') {
    return `${field.label}必须是文本。`;
  }
  const text = value.trim();
  if (text === '') {
    return `${field.label}不能为空。`;
  }
  if (text.length > SETTING_VALUE_MAX_LENGTH) {
    return `${field.label}不能超过 ${SETTING_VALUE_MAX_LENGTH} 字。`;
  }
  if (field.control === 'select') {
    if (!(field.options ?? []).some((option) => option.value === text)) {
      return `${field.label}必须从列表中选择。`;
    }
    target[field.key] = text;
    return null;
  }
  if (field.format === 'https-url') {
    const normalized = normalizeHttpsUrl(text);
    if (normalized === null) {
      return `${field.label}必须是以 https:// 开头的有效地址，且不能包含账号信息。`;
    }
    target[field.key] = normalized;
    return null;
  }
  target[field.key] = text;
  return null;
}

/** 规范化 https 地址：必须是合法的 https 地址且不含账号密码；去除末尾斜杠。不合法返回 null。 */
function normalizeHttpsUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return null;
  }
  return text.replace(/\/+$/, '');
}

/**
 * 读取更换访问密钥的请求：服务商标识和密钥必填，密钥不能含空白字符。
 * @param rawInput 界面提交的原始内容。
 * @throws ValidationError 内容不合法，密钥错误以 apiKey 定位。
 */
export function readApiKeyInput(rawInput: unknown): { readonly providerId: number; readonly apiKey: string } {
  const source = readRecord(rawInput);
  const providerId = readIdentifier(source, 'providerId', '服务商');
  const value = source[API_KEY_FIELD_KEY];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError({ [API_KEY_FIELD_KEY]: '访问密钥不能为空。' });
  }
  const apiKey = value.trim();
  if (/\s/.test(apiKey)) {
    throw new ValidationError({ [API_KEY_FIELD_KEY]: '访问密钥不能包含空格或换行。' });
  }
  if (apiKey.length > API_KEY_MAX_LENGTH) {
    throw new ValidationError({ [API_KEY_FIELD_KEY]: `访问密钥不能超过 ${API_KEY_MAX_LENGTH} 个字符。` });
  }
  return { providerId, apiKey };
}

/**
 * 读取只含服务商标识的请求，如清除访问密钥。
 * @param rawInput 界面提交的原始内容。
 * @throws ValidationError 标识无效。
 */
export function readProviderId(rawInput: unknown): number {
  return readIdentifier(readRecord(rawInput), 'providerId', '服务商');
}

/**
 * 读取模型启用状态的修改请求。
 * @param rawInput 界面提交的原始内容。
 * @throws ValidationError 标识无效或启用状态不是布尔值。
 */
export function readModelEnabledInput(rawInput: unknown): { readonly modelId: number; readonly isEnabled: boolean } {
  const source = readRecord(rawInput);
  const modelId = readIdentifier(source, 'modelId', '模型');
  if (typeof source.isEnabled !== 'boolean') {
    throw new ValidationError({ isEnabled: '启用状态必须是开或关。' });
  }
  return { modelId, isEnabled: source.isEnabled };
}
