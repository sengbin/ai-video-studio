// ------------------------------------------------------------------------
// 名称：work-rules.ts
// 说明：作品创建的校验与规范化：作品名称与形态，灵感图片和小说原文文件的类型、数量、大小与内容检查。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：文件由表单以 JSON 文本传输（[{ name, mimeType, size, data }]，data 为 Base64），界面的限制只是体验层，这里按内容再次校验：图片按文件头判断真实格式，小说必须是合法的 UTF-8。
// ------------------------------------------------------------------------

import { NewWorkSource, WorkInput, WorkKind, WorkSourceType, WorkUpdate } from '../models/work';
import { FieldErrors, assertNoFieldErrors, readRecord, readText } from './field-readers';
import { getExtension, readUploadedFiles } from './upload-readers';

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

const UTF8_BOM = [0xef, 0xbb, 0xbf];

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

/**
 * 校验并规范化修改作品时的名称与形态。
 * @param rawInput 表单提交的原始内容。
 * @param currentKind 作品现有的形态；不允许修改形态时原样保留。
 * @param canChangeKind 是否允许修改形态；为 false 时忽略提交内容中的形态。
 * @param sourceType 作品的素材来源；灵感图片作品还要校验并返回提交的完整图片列表。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeWorkUpdate(
  rawInput: unknown,
  currentKind: WorkKind,
  canChangeKind: boolean,
  sourceType: WorkSourceType = 'text'
): WorkUpdate {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const name = readText(source, { key: 'workName', label: '作品名称', required: true, maxLength: WORK_NAME_MAX_LENGTH }, errors);
  const kind = canChangeKind ? readWorkKind(source.kind, errors) : currentKind;
  const images = sourceType === 'image' ? readImageSources(source[IMAGE_FIELD_KEY], errors) : undefined;
  assertNoFieldErrors(errors);
  return images === undefined ? { name, kind } : { name, kind, images };
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
