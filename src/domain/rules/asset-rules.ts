// ------------------------------------------------------------------------
// 名称：asset-rules.ts
// 说明：资产的校验与规范化：名称、按类型区分的描述字段、选项、提示词，以及上传的图片与音频文件的类型、数量、大小和内容检查；按文件来源（上传、生成）区分表单包含的字段。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：界面提交的内容不可信，这里按内容再次校验：图片与音频按文件头判断真实格式；图片的缩略图、宽高和音频时长由页面读取后随文件提交，宿主只检查取值范围与缩略图格式；描述字段在库里以 snake_case 键保存；上传来源的表单只含名称、音频的类型与语言描述和文件，生成相关字段不在表单里，更新时由 mergeUploadContent 沿用资产原来的值；生成来源的表单没有文件字段。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import {
  ASSET_ATTRIBUTE_FIELDS,
  ASSET_KINDS,
  AUDIO_KIND_LABELS,
  AssetContent,
  AssetFileSource,
  AssetKind,
  AssetRecord,
  AudioKind,
  NewAssetFile
} from '../models/asset';
import { ASSET_OPTION_SETS, AUDIO_LANGUAGE_OPTIONS } from '../models/option-sets';
import { FieldErrors, assertNoFieldErrors, readOptionalChoice, readOptionalText, readRecord, readText } from './field-readers';
import { UploadedFile, getExtension, readUploadedFiles } from './upload-readers';
import { detectImageMime } from './work-rules';

export const ASSET_NAME_MAX_LENGTH = 50;
/** 单个描述字段的长度上限。 */
export const ASSET_ATTRIBUTE_MAX_LENGTH = 500;
export const ASSET_EXTRA_MAX_LENGTH = 1000;
export const ASSET_PROMPT_MAX_LENGTH = 2000;
/** 画面风格、角色类型等允许手动输入的短文本上限。 */
export const ASSET_CHOICE_MAX_LENGTH = 100;
export const ASSET_STYLE_MAX_LENGTH = 50;

/** 资产文件字段的表单键。 */
export const ASSET_FILE_FIELD_KEY = 'files';
export const ASSET_IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];
export const ASSET_AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.m4a'];
export const ASSET_IMAGE_MAX_FILES = 10;
export const ASSET_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const ASSET_AUDIO_MAX_SECONDS = 60;
/** 页面生成的缩略图大小上限，超过则忽略该缩略图。 */
const THUMBNAIL_MAX_BYTES = 256 * 1024;
/** 图片宽高的合理上限（像素）。 */
const IMAGE_SIDE_MAX = 20000;

/** 校验通过的资产内容与文件。 */
export interface NormalizedAsset {
  readonly content: AssetContent;
  /** 上传来源的文件（含缩略图）；生成来源的表单没有文件字段，为 null。 */
  readonly files: readonly NewAssetFile[] | null;
}

/**
 * 读取入口传来的资产类型，必须是五种之一。
 * @param value 页面或表单参数中的类型。
 * @throws ValidationError 类型无效。
 */
export function readAssetKind(value: unknown): AssetKind {
  if (typeof value !== 'string' || !ASSET_KINDS.includes(value as AssetKind)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '资产类型无效。' });
  }
  return value as AssetKind;
}

/**
 * 校验并规范化资产表单提交的内容（不含所属项目，项目由服务层处理）。
 * @param rawInput 表单提交的原始内容。
 * @param kind 资产类型，由入口决定，编辑时不能修改。
 * @param fileSource 表单对应的文件来源：上传时必须有文件，且不含生成相关字段；生成时没有文件字段。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeAssetContent(rawInput: unknown, kind: AssetKind, fileSource: AssetFileSource): NormalizedAsset {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const isUpload = fileSource === 'upload';

  const name = readText(source, { key: 'name', label: '名称', required: true, maxLength: ASSET_NAME_MAX_LENGTH }, errors);
  const extraRequirements = isUpload
    ? ''
    : readText(source, { key: 'extra', label: '补充要求', required: false, maxLength: ASSET_EXTRA_MAX_LENGTH }, errors);

  if (kind === 'audio') {
    const attributes = readAudioAttributes(source, errors);
    const files = isUpload ? requireFiles(readAudioFile(source[ASSET_FILE_FIELD_KEY], errors), '请上传音频文件。', errors) : null;
    assertNoFieldErrors(errors);
    return {
      content: {
        name,
        attributes,
        composition: '',
        style: null,
        background: '',
        referenceAspectRatio: null,
        extraRequirements,
        promptZh: '',
        promptEn: ''
      },
      files
    };
  }

  // 上传来源的图片资产只有名称和图片，其余字段留空，更新时沿用原值。
  if (isUpload) {
    const files = requireFiles(readImageFiles(source[ASSET_FILE_FIELD_KEY], errors), '请上传参考图。', errors);
    assertNoFieldErrors(errors);
    return {
      content: {
        name,
        attributes: {},
        composition: '',
        style: null,
        background: '',
        referenceAspectRatio: null,
        extraRequirements,
        promptZh: '',
        promptEn: ''
      },
      files
    };
  }

  const options = ASSET_OPTION_SETS[kind];
  const choice = (key: string, label: string): string =>
    readText(source, { key, label, required: false, maxLength: ASSET_CHOICE_MAX_LENGTH }, errors);
  const composition = choice('composition', '视角与构图');
  const background = choice('background', '背景');
  const style = readOptionalText(source, { key: 'style', label: '画面风格', required: false, maxLength: ASSET_STYLE_MAX_LENGTH }, errors);
  const referenceAspectRatio = readOptionalChoice(source, 'referenceAspectRatio', '参考图画幅', options.aspectRatio, errors);

  const attributes: Record<string, string> = {};
  for (const field of ASSET_ATTRIBUTE_FIELDS[kind]) {
    const text = readText(
      source,
      { key: field.formKey, label: field.label, required: false, maxLength: ASSET_ATTRIBUTE_MAX_LENGTH },
      errors
    );
    if (text.length > 0) {
      attributes[field.key] = text;
    }
  }
  assertNoFieldErrors(errors);
  return {
    content: { name, attributes, composition, style, background, referenceAspectRatio, extraRequirements, promptZh: '', promptEn: '' },
    files: null
  };
}

/**
 * 修改上传来源的资产时，把表单内容与资产原有的内容合并：表单没有的生成相关字段（图片资产的描述字段、画面设置，音频的补充要求）沿用原值。
 * @param previous 修改前的资产。
 * @param next 上传来源表单规范化后的内容。
 */
export function mergeUploadContent(previous: AssetRecord, next: AssetContent): AssetContent {
  return {
    ...next,
    attributes: previous.kind === 'audio' ? next.attributes : previous.attributes,
    composition: previous.composition,
    style: previous.style,
    background: previous.background,
    referenceAspectRatio: previous.referenceAspectRatio,
    extraRequirements: previous.extraRequirements
  };
}

/** 上传来源必须至少有一个文件，没有时在文件字段上报错。 */
function requireFiles(files: NewAssetFile[], message: string, errors: FieldErrors): NewAssetFile[] {
  if (files.length === 0 && errors[ASSET_FILE_FIELD_KEY] === undefined) {
    errors[ASSET_FILE_FIELD_KEY] = message;
  }
  return files;
}

/** 校验并规范化手动保存的提示词；两种语言都可以为空。 */
export function normalizeAssetPrompts(rawInput: unknown): { readonly promptZh: string; readonly promptEn: string } {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const promptZh = readText(source, { key: 'promptZh', label: '中文提示词', required: false, maxLength: ASSET_PROMPT_MAX_LENGTH }, errors);
  const promptEn = readText(source, { key: 'promptEn', label: '英文提示词', required: false, maxLength: ASSET_PROMPT_MAX_LENGTH }, errors);
  assertNoFieldErrors(errors);
  return { promptZh, promptEn };
}

/** 读取音频资产的描述字段：音频类型必填，描述可选，语言只对音色参考有意义。 */
function readAudioAttributes(source: Record<string, unknown>, errors: FieldErrors): Record<string, string> {
  const attributes: Record<string, string> = {};
  const rawKind = source.audioKind;
  const entries = Object.entries(AUDIO_KIND_LABELS) as Array<[AudioKind, string]>;
  const found = entries.find(([key, label]) => rawKind === key || rawKind === label);
  if (found === undefined) {
    errors.audioKind = '请选择音频类型。';
  } else {
    attributes.audio_kind = found[0];
  }
  const description = readText(
    source,
    { key: 'description', label: '描述', required: false, maxLength: ASSET_ATTRIBUTE_MAX_LENGTH },
    errors
  );
  if (description.length > 0) {
    attributes.description = description;
  }
  const language = readOptionalChoice(source, 'language', '语言', AUDIO_LANGUAGE_OPTIONS, errors);
  if (language !== null && found?.[0] === 'voice') {
    attributes.language = language;
  }
  return attributes;
}

/** 读取图片资产上传的图片：最多 10 张，按文件头识别格式；页面生成的缩略图和宽高一并读取。 */
function readImageFiles(value: unknown, errors: FieldErrors): NewAssetFile[] {
  const key = ASSET_FILE_FIELD_KEY;
  const uploaded = readUploadedFiles(value, key, '参考图', ASSET_IMAGE_MAX_BYTES, errors);
  if (uploaded === undefined) {
    return [];
  }
  if (uploaded.length > ASSET_IMAGE_MAX_FILES) {
    errors[key] = `参考图最多 ${ASSET_IMAGE_MAX_FILES} 张（当前 ${uploaded.length} 张）。`;
    return [];
  }

  const files: NewAssetFile[] = [];
  for (const [index, file] of uploaded.entries()) {
    const mime = detectImageMime(file.content);
    if (mime === null) {
      errors[key] = `“${file.name}”不是有效的 PNG、JPEG 或 WebP 图片。`;
      return [];
    }
    files.push({
      role: 'reference',
      fileName: file.name,
      mime,
      width: readSide(file.raw.width),
      height: readSide(file.raw.height),
      durationSeconds: null,
      content: file.content,
      sortOrder: index
    });
    const thumbnail = readThumbnail(file, index);
    if (thumbnail !== undefined) {
      files.push(thumbnail);
    }
  }
  return files;
}

/** 读取音频资产上传的音频：最多 1 个文件，按文件头识别格式，时长为页面读取的值且不超过上限。 */
function readAudioFile(value: unknown, errors: FieldErrors): NewAssetFile[] {
  const key = ASSET_FILE_FIELD_KEY;
  const uploaded = readUploadedFiles(value, key, '音频文件', ASSET_AUDIO_MAX_BYTES, errors);
  if (uploaded === undefined || uploaded.length === 0) {
    return [];
  }
  if (uploaded.length !== 1) {
    errors[key] = '只能选择 1 个音频文件。';
    return [];
  }
  const [file] = uploaded;
  if (!ASSET_AUDIO_EXTENSIONS.includes(getExtension(file.name))) {
    errors[key] = `音频文件只支持 ${ASSET_AUDIO_EXTENSIONS.join('、')}。`;
    return [];
  }
  const mime = detectAudioMime(file.content);
  if (mime === null) {
    errors[key] = `“${file.name}”不是有效的 MP3、WAV 或 M4A 音频。`;
    return [];
  }
  const duration = file.raw.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    errors[key] = `无法读取“${file.name}”的时长，请换一个文件。`;
    return [];
  }
  if (duration > ASSET_AUDIO_MAX_SECONDS) {
    errors[key] = `“${file.name}”时长 ${Math.round(duration)} 秒，超过 ${ASSET_AUDIO_MAX_SECONDS} 秒。`;
    return [];
  }
  return [
    {
      role: 'reference',
      fileName: file.name,
      mime,
      width: null,
      height: null,
      durationSeconds: Math.round(duration * 100) / 100,
      content: file.content,
      sortOrder: 0
    }
  ];
}

/** 读取页面生成的缩略图：必须是受支持的图片且不超过上限；不合格时忽略，不影响保存。 */
function readThumbnail(file: UploadedFile, index: number): NewAssetFile | undefined {
  const raw = file.raw.thumbnail;
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== 'string' || data.length === 0 || data.length > Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return undefined;
  }
  const content = Buffer.from(data, 'base64');
  const mime = detectImageMime(content);
  if (mime === null || content.length === 0 || content.length > THUMBNAIL_MAX_BYTES) {
    return undefined;
  }
  return { role: 'thumbnail', fileName: file.name, mime, width: null, height: null, durationSeconds: null, content, sortOrder: index };
}

/** 读取图片的宽或高：正整数且在合理范围内，否则为 null。 */
function readSide(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= IMAGE_SIDE_MAX ? value : null;
}

/** 按文件头识别音频格式（MP3、WAV、M4A），返回 MIME 类型；无法识别返回 null。 */
export function detectAudioMime(content: Uint8Array): string | null {
  const startsWith = (offset: number, bytes: readonly number[]) => bytes.every((byte, index) => content[offset + index] === byte);
  if (startsWith(0, [0x52, 0x49, 0x46, 0x46]) && startsWith(8, [0x57, 0x41, 0x56, 0x45])) {
    return 'audio/wav';
  }
  if (startsWith(4, [0x66, 0x74, 0x79, 0x70])) {
    return 'audio/mp4';
  }
  // MP3：带 ID3 标签，或直接以帧同步字（11 个 1）开头。
  if (startsWith(0, [0x49, 0x44, 0x33]) || (content[0] === 0xff && (content[1] & 0xe0) === 0xe0)) {
    return 'audio/mpeg';
  }
  return null;
}
