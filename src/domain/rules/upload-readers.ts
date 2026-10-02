// ------------------------------------------------------------------------
// 名称：upload-readers.ts
// 说明：读取表单提交的文件列表：解析 JSON、校验文件名、解码 Base64 并检查大小。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：文件以 JSON 文本传输（[{ name, mimeType, size, data, ... }]，data 为 Base64）；作品素材与资产文件共用，调用方再按各自规则检查文件类型与内容。
// ------------------------------------------------------------------------

import { FieldErrors } from './field-readers';

/** 文件名保存时的最大长度。 */
const FILE_NAME_MAX_LENGTH = 200;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 界面提交的一个文件，内容已解码；raw 是提交的原始条目，调用方可从中读取额外字段。 */
export interface UploadedFile {
  readonly name: string;
  readonly content: Buffer;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * 读取表单提交的文件列表并解码 Base64，同时检查单个文件的大小。
 * @returns 文件列表；格式不正确时记录错误并返回 undefined。
 */
export function readUploadedFiles(
  value: unknown,
  key: string,
  label: string,
  maxBytes: number,
  errors: FieldErrors
): UploadedFile[] | undefined {
  const items = parseFileItems(value);
  if (items === undefined) {
    errors[key] = `${label}的内容格式不正确。`;
    return undefined;
  }

  const files: UploadedFile[] = [];
  for (const item of items) {
    const name = readFileName(item.name);
    if (name === undefined || typeof item.data !== 'string' || item.data.length % 4 !== 0 || !BASE64_PATTERN.test(item.data)) {
      errors[key] = `${label}的内容格式不正确。`;
      return undefined;
    }
    // 先按 Base64 长度粗略估算，避免为明显超限的文件分配内存。
    if ((item.data.length / 4) * 3 > maxBytes + 3) {
      errors[key] = `“${name}”超过 ${formatMegabytes(maxBytes)}。`;
      return undefined;
    }
    const content = Buffer.from(item.data, 'base64');
    if (content.length === 0) {
      errors[key] = `“${name}”是空文件。`;
      return undefined;
    }
    if (content.length > maxBytes) {
      errors[key] = `“${name}”超过 ${formatMegabytes(maxBytes)}。`;
      return undefined;
    }
    files.push({ name, content, raw: item });
  }
  return files;
}

/** 把提交值解析为文件条目数组；空串视为没有文件，格式不对返回 undefined。 */
function parseFileItems(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
    return undefined;
  }
  return parsed as Array<Record<string, unknown>>;
}

/** 取文件名的最后一段并检查长度；不是有效文件名返回 undefined。 */
function readFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = (value.split(/[\\/]/).pop() ?? '').trim();
  return name.length === 0 || name.length > FILE_NAME_MAX_LENGTH ? undefined : name;
}

/** 文件名的小写扩展名（含点）；没有扩展名返回空串。 */
export function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
}

/** 字节数转为“N MB”的说明文字。 */
export function formatMegabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}
