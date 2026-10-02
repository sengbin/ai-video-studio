// ------------------------------------------------------------------------
// 名称：asset-prompt-rules.ts
// 说明：资产提示词生成的规则：把资产内容整理为提示词素材，按类型给出画面（声音）重点，校验模型返回的中英文提示词。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：图像类资产生成参考图提示词，音频资产生成音频生成提示词；素材来自已保存的资产；模型输出不合格抛出 GeneratedOutputError。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';
import {
  ASSET_ATTRIBUTE_FIELDS,
  ASSET_KIND_LABELS,
  AUDIO_KIND_LABELS,
  AssetKind,
  AssetRecord,
  AudioKind
} from '../models/asset';
import { ASSET_PROMPT_MAX_LENGTH } from './asset-rules';

/** 随请求发送给模型的参考图数量上限。 */
export const ASSET_PROMPT_MAX_IMAGES = 3;

/** 参考图原文件超过这个大小时，改发缩略图，避免请求过大。 */
export const ASSET_PROMPT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 各类型图像资产参考图的画面重点，写入提示词模板。 */
const IMAGE_FOCUS: Readonly<Record<Exclude<AssetKind, 'audio'>, string>> = {
  character: '单个角色的形象：面部与发型、体型、服装与配饰，主体完整、居中，不出现其他人物。',
  scene: '一个空间或场景环境：布局、陈设、光线与氛围，通常不出现人物。',
  prop: '单个道具：外形、材质、颜色、细节与当前状态，主体清晰突出。',
  effect: '一种视觉特效：形态、颜色、质感、动态与对环境的影响。'
};

/** 各类型音频的重点，写入提示词模板。 */
const AUDIO_FOCUS: Readonly<Record<AudioKind, string>> = {
  voice: '一段示范语音：描述说话人的声音特征（性别、年龄感、音色、语速、情绪），并给出一句符合角色的示范台词，让人听一句就能判断音色。',
  music: '一段背景音乐：风格、情绪、主要乐器、节奏与速度，是否纯音乐。',
  sfx: '一个音效：声音的来源、质感、持续方式与环境感，描述尽量具体。'
};

/** 整理后的资产草稿。 */
export interface AssetDraftDescription {
  /** 草稿里的名称；没有填写为空串。 */
  readonly name: string;
  /** “标签：内容”形式的行，名称在最前。 */
  readonly lines: readonly string[];
  /** 名称以外用户填写的字段数。 */
  readonly detailCount: number;
}

/** 模型生成的中英文提示词。 */
export interface AssetPrompts {
  readonly promptZh: string;
  readonly promptEn: string;
}

/** 读取音频资产的类型；没有设置时按音色参考处理。 */
export function readAudioKind(attributes: Readonly<Record<string, string>>): AudioKind {
  const value = attributes.audio_kind;
  return value === 'music' || value === 'sfx' ? value : 'voice';
}

/** 资产类型（音频为其音频类型）在提示词里的名称，用作模板变量。 */
export function promptKindLabel(asset: Pick<AssetRecord, 'kind' | 'attributes'>): string {
  return asset.kind === 'audio' ? AUDIO_KIND_LABELS[readAudioKind(asset.attributes)] : ASSET_KIND_LABELS[asset.kind];
}

/** 资产的画面（声音）重点。 */
export function promptFocus(asset: Pick<AssetRecord, 'kind' | 'attributes'>): string {
  return asset.kind === 'audio' ? AUDIO_FOCUS[readAudioKind(asset.attributes)] : IMAGE_FOCUS[asset.kind];
}

/** 把已保存的资产转换为表单键的文本值，供整理草稿使用。 */
export function assetToDraftValues(asset: AssetRecord): Record<string, string> {
  const values: Record<string, string> = { name: asset.name, extra: asset.extraRequirements };
  if (asset.kind === 'audio') {
    values.audioKind = AUDIO_KIND_LABELS[readAudioKind(asset.attributes)];
    values.description = asset.attributes.description ?? '';
    values.language = asset.attributes.language ?? '';
    return values;
  }
  values.composition = asset.composition;
  values.style = asset.style ?? '';
  values.background = asset.background;
  values.referenceAspectRatio = asset.referenceAspectRatio ?? '';
  for (const field of ASSET_ATTRIBUTE_FIELDS[asset.kind]) {
    values[field.formKey] = asset.attributes[field.key] ?? '';
  }
  return values;
}

/**
 * 把资产内容整理成提示词素材；空字段不列出。
 * @param kind 资产类型。
 * @param values 表单键到文本。
 */
export function describeAssetDraft(kind: AssetKind, values: Readonly<Record<string, unknown>>): AssetDraftDescription {
  const read = (key: string): string => {
    const value = values[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const lines: string[] = [];
  let detailCount = 0;
  const addDetail = (label: string, key: string): void => {
    const text = read(key);
    if (text.length > 0) {
      lines.push(`${label}：${text}`);
      detailCount += 1;
    }
  };

  const name = read('name');
  if (name.length > 0) {
    lines.push(`${ASSET_KIND_LABELS[kind]}名称：${name}`);
  }
  if (kind === 'audio') {
    lines.push(`音频类型：${read('audioKind') || AUDIO_KIND_LABELS.voice}`);
    addDetail('描述', 'description');
    addDetail('语言', 'language');
    addDetail('补充要求', 'extra');
    return { name, lines, detailCount };
  }

  addDetail('视角与构图', 'composition');
  const style = read('style');
  if (style.length > 0) {
    lines.push(`画面风格：${style}`);
    detailCount += 1;
  }
  addDetail('背景', 'background');
  addDetail('参考图画幅', 'referenceAspectRatio');
  for (const field of ASSET_ATTRIBUTE_FIELDS[kind]) {
    addDetail(field.label, field.formKey);
  }
  addDetail('补充要求', 'extra');
  return { name, lines, detailCount };
}

/**
 * 校验模型提交的提示词。
 * @param raw 模型通过工具提交的对象。
 * @throws GeneratedOutputError 缺少提示词、为空或过长。
 */
export function parseAssetPrompts(raw: unknown): AssetPrompts {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GeneratedOutputError(['结果必须是包含 promptZh 和 promptEn 的对象。']);
  }
  const source = raw as Record<string, unknown>;
  const issues: string[] = [];
  const read = (key: 'promptZh' | 'promptEn', label: string): string => {
    const value = source[key];
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length === 0) {
      issues.push(`${label}不能为空。`);
    } else if (text.length > ASSET_PROMPT_MAX_LENGTH) {
      issues.push(`${label}有 ${text.length} 字，超过上限 ${ASSET_PROMPT_MAX_LENGTH} 字。`);
    }
    return text;
  };
  const promptZh = read('promptZh', '中文提示词');
  const promptEn = read('promptEn', '英文提示词');
  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return { promptZh, promptEn };
}
