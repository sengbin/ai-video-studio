// ------------------------------------------------------------------------
// 名称：work-rules.ts
// 说明：作品创建的校验与规范化：作品名称与形态，灵感图片和小说原文文件的类型、数量、大小与内容检查。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：文件由表单以 JSON 文本传输（[{ name, mimeType, size, data }]，data 为 Base64），界面的限制只是体验层，这里按内容再次校验：图片按文件头判断真实格式，小说必须是合法的 UTF-8。
// ------------------------------------------------------------------------

import { NewWorkSource, WorkInput, WorkKind, WorkSourceType } from '../models/work';
import { FieldErrors, assertNoFieldErrors, readRecord, readText } from './field-readers';

export const WORK_NAME_MAX_LENGTH = 60;

/** 作品形态在界面中的名称，表单的单选项使用它。 */
export const WORK_KIND_LABELS: Readonly<Record<WorkKind, string>> = {
  single: '单个短视频',
  series: '多集短片'
};

/** 素材来源在界面中的名称。 */
export const SOURCE_TYPE_LABELS: Readonly<Record<WorkSourceType, string>> = {
  text: '文字灵感',
  image: '灵感图片',
  novel: '小说原文'
};

/** 表单字段键：灵感图片、小说原文件。 */
export const IMAGE_FIELD_KEY = 'images';
export const NOVEL_FIELD_KEY = 'novelFile';

export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];
export const IMAGE_MAX_FILES = 10;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const NOVEL_EXTENSIONS: readonly string[] = ['.txt', '.md'];
export const NOVEL_MAX_BYTES = 5 * 1024 * 1024;

/** 文件名保存时的最大长度。 */
const FILE_NAME_MAX_LENGTH = 200;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const UTF8_BOM = [0xef, 0xbb, 0xbf];

/** 界面提交的一个文件，内容已解码。 */
interface UploadedFile {
  readonly name: string;
  readonly content: Buffer;
}

/** 作品创建时校验通过的内容。 */
export interface NormalizedWorkCreation {
  readonly input: WorkInput;
  readonly sources: readonly NewWorkSource[];
}

/**
 * 校验并规范化创建作品时的名称、形态和素材文件。
 * @param rawInput 表单提交的原始内容。
 * @param sourceType 素材来源，由入口决定。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeWorkCreation(rawInput: unknown, sourceType: WorkSourceType): NormalizedWorkCreation {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};

  const name = readText(source, { key: 'workName', label: '作品名称', required: true, maxLength: WORK_NAME_MAX_LENGTH }, errors);
  const kind = readWorkKind(source.kind, errors);
  const sources =
    sourceType === 'image'
      ? readImageSources(source[IMAGE_FIELD_KEY], errors)
      : sourceType === 'novel'
        ? readNovelSource(source[NOVEL_FIELD_KEY], errors)
        : [];

  assertNoFieldErrors(errors);
  return { input: { name, kind, sourceType }, sources };
}

/** 读取作品形态：接受界面名称或内部键。 */
function readWorkKind(value: unknown, errors: FieldErrors): WorkKind {
  const entries = Object.entries(WORK_KIND_LABELS) as Array<[WorkKind, string]>;
  const found = entries.find(([key, label]) => value === key || value === label);
  if (found === undefined) {
    errors.kind = '请选择作品形态。';
    return 'single';
  }
  return found[0];
}

/** 读取灵感图片：至少 1 张、最多 10 张，按文件头识别 PNG、JPEG、WebP。 */
function readImageSources(value: unknown, errors: FieldErrors): NewWorkSource[] {
  const files = readUploadedFiles(value, IMAGE_FIELD_KEY, '灵感图片', IMAGE_MAX_BYTES, errors);
  if (files === undefined) {
    return [];
  }
  if (files.length === 0) {
    errors[IMAGE_FIELD_KEY] = '请至少选择 1 张灵感图片。';
    return [];
  }
  if (files.length > IMAGE_MAX_FILES) {
    errors[IMAGE_FIELD_KEY] = `灵感图片最多 ${IMAGE_MAX_FILES} 张（当前 ${files.length} 张）。`;
    return [];
  }

  const sources: NewWorkSource[] = [];
  for (const file of files) {
    const mime = detectImageMime(file.content);
    if (mime === null) {
      errors[IMAGE_FIELD_KEY] = `“${file.name}”不是有效的 PNG、JPEG 或 WebP 图片。`;
      return [];
    }
    sources.push({ kind: 'image', fileName: file.name, mime, content: file.content });
  }
  return sources;
}

/** 读取小说原文：恰好 1 个文件，必须是能按 UTF-8 解码的文本；去掉开头的 BOM。 */
function readNovelSource(value: unknown, errors: FieldErrors): NewWorkSource[] {
  const files = readUploadedFiles(value, NOVEL_FIELD_KEY, '原作文件', NOVEL_MAX_BYTES, errors);
  if (files === undefined) {
    return [];
  }
  if (files.length !== 1) {
    errors[NOVEL_FIELD_KEY] = '请选择 1 个原作文件。';
    return [];
  }

  const [file] = files;
  const extension = getExtension(file.name);
  if (!NOVEL_EXTENSIONS.includes(extension)) {
    errors[NOVEL_FIELD_KEY] = `原作文件只支持 ${NOVEL_EXTENSIONS.join('、')}。`;
    return [];
  }
  const hasBom = UTF8_BOM.every((byte, index) => file.content[index] === byte);
  const content = hasBom ? file.content.subarray(UTF8_BOM.length) : file.content;
  const text = decodeUtf8(content);
  if (text === undefined || text.includes('\u0000')) {
    errors[NOVEL_FIELD_KEY] = `“${file.name}”不是 UTF-8 编码的文本文件，请另存为 UTF-8 后重试。`;
    return [];
  }
  if (text.trim().length === 0) {
    errors[NOVEL_FIELD_KEY] = `“${file.name}”没有可用的文字内容。`;
    return [];
  }
  return [{ kind: 'novel_text', fileName: file.name, mime: extension === '.md' ? 'text/markdown' : 'text/plain', content }];
}

/**
 * 读取表单提交的文件列表并解码 Base64，同时检查单个文件的大小。
 * @returns 文件列表；格式不正确时记录错误并返回 undefined。
 */
function readUploadedFiles(
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
    files.push({ name, content });
  }
  return files;
}

/** 把提交值解析为文件条目数组；空串视为没有文件，格式不对返回 undefined。 */
function parseFileItems(value: unknown): Array<{ name?: unknown; data?: unknown }> | undefined {
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
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'object' || item === null)) {
    return undefined;
  }
  return parsed as Array<{ name?: unknown; data?: unknown }>;
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
function getExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
}

/** 按文件头识别图片格式，返回 MIME 类型；不是受支持的格式返回 null。 */
export function detectImageMime(content: Uint8Array): string | null {
  const startsWith = (offset: number, bytes: readonly number[]) => bytes.every((byte, index) => content[offset + index] === byte);
  if (startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(0, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp';
  }
  return null;
}

/** 严格按 UTF-8 解码；含非法字节时返回 undefined。 */
function decodeUtf8(content: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

/** 字节数转为“N MB”的说明文字。 */
function formatMegabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}
