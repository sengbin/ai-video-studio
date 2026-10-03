// ------------------------------------------------------------------------
// 名称：model-capability-rules.ts
// 说明：模型能力描述的规则：入库 JSON 与领域对象互转（snake_case 与 camelCase）、时长校验、设置页用的能力摘要。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：能力描述只由适配器（代码）写入，读取时只确认是 JSON 对象，不逐字段校验。
// ------------------------------------------------------------------------

import {
  AUTO_DURATION_SECONDS,
  AudioCapability,
  DurationCapability,
  ImageCapability,
  ModelCapability,
  ModelKind,
  TextCapability,
  VIDEO_AUDIO_ELEMENT_LABELS,
  VideoCapability
} from '../models/model-capability';

/** 音频类型的显示名称。 */
const AUDIO_KIND_LABELS: Readonly<Record<string, string>> = { voice: '音色参考', music: '配乐', sfx: '音效' };

/** 摘要中列表项之间的分隔符。 */
const LIST_SEPARATOR = '、';

/** snake_case 键转 camelCase。 */
function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** camelCase 键转 snake_case。 */
function toSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** 递归转换对象的键名；数组元素和嵌套对象一并处理，其他值原样返回。 */
function convertKeys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeys(item, convert));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [convert(key), convertKeys(item, convert)]));
  }
  return value;
}

/**
 * 把能力描述转换为入库的 JSON 文本，键名为 snake_case。
 * @param capability 领域对象。
 */
export function serializeCapability(capability: ModelCapability): string {
  return JSON.stringify(convertKeys(capability, toSnakeKey));
}

/**
 * 把入库的 JSON 文本还原为能力描述，键名为 camelCase。
 * @param json 数据库中的 capability_json。
 * @throws Error 不是合法的 JSON 对象，说明数据已损坏。
 */
export function parseCapability(json: string): ModelCapability {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('模型能力描述不是 JSON 对象。');
  }
  return convertKeys(parsed, toCamelKey) as ModelCapability;
}

/**
 * 判断时长（秒）是否符合约束：取 AUTO_DURATION_SECONDS 时看是否允许自动；给出可选值时必须在其中；给出范围时必须在范围内且落在步长上。
 * @param duration 时长约束。
 * @param seconds 待判断的时长。
 */
export function isDurationAllowed(duration: DurationCapability, seconds: number): boolean {
  if (seconds === AUTO_DURATION_SECONDS) {
    return duration.allowAuto === true;
  }
  if (duration.options !== undefined) {
    return duration.options.includes(seconds);
  }
  const { min, max, step } = duration;
  if (min !== undefined && seconds < min) {
    return false;
  }
  if (max !== undefined && seconds > max) {
    return false;
  }
  return step === undefined || min === undefined || Number.isInteger((seconds - min) / step);
}

/**
 * 时长约束的文字描述，如“2–30 秒，可由模型自动决定”。
 * @param duration 时长约束。
 */
export function describeDuration(duration: DurationCapability): string {
  let text: string;
  if (duration.options !== undefined) {
    text = `${duration.options.join(LIST_SEPARATOR)} 秒`;
  } else if (duration.min !== undefined && duration.max !== undefined) {
    text = `${duration.min}–${duration.max} 秒`;
  } else if (duration.max !== undefined) {
    text = `最长 ${duration.max} 秒`;
  } else {
    text = '不限';
  }
  return duration.allowAuto === true ? `${text}，可由模型自动决定` : text;
}

/** 列表项存在时返回“标签：项1、项2”，否则不产生摘要行。 */
function listLine(label: string, items: readonly (string | number)[]): string[] {
  return items.length === 0 ? [] : [`${label}：${items.join(LIST_SEPARATOR)}`];
}

/** 把 token 数写成“1M”“128K”这样的短写法。 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function summarizeText(capability: TextCapability): string[] {
  return [
    `上下文：${formatTokens(capability.contextTokens)}`,
    `最大输出：${formatTokens(capability.maxOutputTokens)}`,
    `图片输入：${capability.imageInput ? '支持' : '不支持'}`
  ];
}

function summarizeVideo(capability: VideoCapability): string[] {
  const inputs: string[] = [];
  if (capability.firstFrame) inputs.push('首帧');
  if (capability.lastFrame) inputs.push('尾帧');
  if (capability.referenceImagesMax > 0) inputs.push(`参考图（最多 ${capability.referenceImagesMax} 张）`);
  if (capability.audioInputMax !== null) inputs.push(`参考音频（最多 ${capability.audioInputMax.count} 段）`);
  const audio = capability.audioModes.includes('native')
    ? `原生生成${capability.audioElements.length > 0 ? `（${capability.audioElements.map((element) => VIDEO_AUDIO_ELEMENT_LABELS[element]).join(LIST_SEPARATOR)}）` : ''}`
    : '无声';
  return [
    ...listLine('画幅', capability.aspectRatios),
    ...listLine('分辨率', capability.resolutions),
    `时长：${describeDuration(capability.duration)}`,
    ...listLine('帧率', capability.fps),
    `输入：${inputs.length === 0 ? '仅文字' : inputs.join(LIST_SEPARATOR)}`,
    `声音：${audio}`
  ];
}

function summarizeImage(capability: ImageCapability): string[] {
  return [
    ...listLine('画幅', capability.aspectRatios),
    ...listLine('分辨率', capability.resolutions),
    `单次最多生成：${capability.imagesPerRequestMax} 张`,
    `参考图：${capability.referenceImagesMax > 0 ? `最多 ${capability.referenceImagesMax} 张` : '不支持'}`
  ];
}

function summarizeAudio(capability: AudioCapability): string[] {
  return [
    ...listLine('类型', capability.audioKinds.map((kind) => AUDIO_KIND_LABELS[kind] ?? kind)),
    `时长：${describeDuration(capability.duration)}`,
    ...listLine('语言', capability.languages),
    ...(capability.voices.length > 0 ? [`预置音色：${capability.voices.length} 个`] : []),
    `参考音频：${capability.referenceAudio ? '支持' : '不支持'}`
  ];
}

/**
 * 生成设置页显示的能力摘要，每项一行。
 * @param kind 模型类型，决定能力描述的解读方式。
 * @param capability 能力描述。
 */
export function summarizeCapability(kind: ModelKind, capability: ModelCapability): string[] {
  switch (kind) {
    case 'text':
      return summarizeText(capability as TextCapability);
    case 'video':
      return summarizeVideo(capability as VideoCapability);
    case 'image':
      return summarizeImage(capability as ImageCapability);
    case 'audio':
      return summarizeAudio(capability as AudioCapability);
  }
}
