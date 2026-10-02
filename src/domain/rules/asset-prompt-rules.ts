// ------------------------------------------------------------------------
// 名称：asset-prompt-rules.ts
// 说明：资产提示词生成的规则：把表单草稿整理为提示词素材，校验模型返回的中英文提示词。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：只处理图像类资产；草稿来自尚未保存的表单值，不要求通过完整校验；模型输出不合格抛出 GeneratedOutputError。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';
import { ASSET_ATTRIBUTE_FIELDS, ASSET_KIND_LABELS, AssetKind } from '../models/asset';
import { ASSET_PROMPT_MAX_LENGTH } from './asset-rules';

/** 可以生成提示词的资产类型（音频没有提示词）。 */
export type PromptAssetKind = Exclude<AssetKind, 'audio'>;

/** 随请求发送给模型的参考图数量上限。 */
export const ASSET_PROMPT_MAX_IMAGES = 3;

/** 各类型资产参考图的画面重点，写入提示词模板。 */
export const ASSET_PROMPT_FOCUS: Readonly<Record<PromptAssetKind, string>> = {
  character: '单个角色的形象：面部与发型、体型、服装与配饰，主体完整、居中，不出现其他人物。',
  scene: '一个空间或场景环境：布局、陈设、光线与氛围，通常不出现人物。',
  prop: '单个道具：外形、材质、颜色、细节与当前状态，主体清晰突出。',
  effect: '一种视觉特效：形态、颜色、质感、动态与对环境的影响。'
};

/** 整理后的资产草稿。 */
export interface AssetDraftDescription {
  /** 草稿里的名称；没有填写为空串。 */
  readonly name: string;
  /** “标签：内容”形式的行，名称在最前。 */
  readonly lines: readonly string[];
  /** 用户填写的名称以外的字段数（不含项目风格带来的画面风格）。 */
  readonly detailCount: number;
}

/** 模型生成的中英文提示词。 */
export interface AssetPrompts {
  readonly promptZh: string;
  readonly promptEn: string;
}

/** 判断资产类型是否支持生成提示词。 */
export function isPromptAssetKind(kind: AssetKind): kind is PromptAssetKind {
  return kind !== 'audio';
}

/**
 * 把表单草稿整理成提示词素材；空字段不列出。
 * @param kind 资产类型。
 * @param values 表单当前值（字段键到文本）。
 * @param projectStyle 项目的视觉风格；资产自己没有设置风格时作为画面风格。
 */
export function describeAssetDraft(
  kind: PromptAssetKind,
  values: Readonly<Record<string, unknown>>,
  projectStyle: string | null
): AssetDraftDescription {
  const read = (key: string): string => {
    const value = values[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const lines: string[] = [];
  let detailCount = 0;
  const add = (label: string, text: string): void => {
    lines.push(`${label}：${text}`);
  };
  const addDetail = (label: string, key: string): void => {
    const text = read(key);
    if (text.length > 0) {
      add(label, text);
      detailCount += 1;
    }
  };

  const name = read('name');
  if (name.length > 0) {
    add(`${ASSET_KIND_LABELS[kind]}名称`, name);
  }
  addDetail('视角与构图', 'composition');
  const style = read('style');
  if (style.length > 0) {
    add('画面风格', style);
    detailCount += 1;
  } else if (projectStyle !== null && projectStyle.length > 0) {
    add('画面风格（沿用项目风格）', projectStyle);
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
