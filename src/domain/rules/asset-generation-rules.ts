// ------------------------------------------------------------------------
// 名称：asset-generation-rules.ts
// 说明：资产生成的规则：修订号的维护、提示词“需更新”与图片“有改动未生成”的推算、能否提交生成的判断。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：规则见 docs/database-design.md 4.9；修改表单或提示词只改修订号，不创建空版本；纯函数，不依赖数据库。
// ------------------------------------------------------------------------

import { AssetContent, AssetFileRecord, AssetGenerationSummary, AssetKind, AssetRecord, NewAssetFile } from '../models/asset';
import { ModelKind } from '../models/model-capability';

/** 保存资产时要写入的修订信息。 */
export interface AssetRevisionUpdate {
  readonly contentRevision: number;
  readonly promptRevision: number;
  readonly promptContentRevision: number;
  /** 手动改动了参考文件，不再对应任何生成版本。 */
  readonly clearAdopted: boolean;
}

/** 资产类型对应的生成模型类型：音频资产用音频模型，其余用图像模型。 */
export function modelKindOfAsset(kind: AssetKind): ModelKind {
  return kind === 'audio' ? 'audio' : 'image';
}

/** 稳定的 JSON 文本：键按字典序，用于比较描述字段。 */
function stableAttributes(attributes: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));
}

/** 影响生成的表单字段（不含名称、提示词、文件）是否发生变化。 */
export function contentFieldsChanged(previous: AssetRecord, next: AssetContent): boolean {
  return (
    stableAttributes(previous.attributes) !== stableAttributes(next.attributes) ||
    previous.composition !== next.composition ||
    previous.style !== next.style ||
    previous.background !== next.background ||
    previous.referenceAspectRatio !== next.referenceAspectRatio ||
    previous.extraRequirements !== next.extraRequirements
  );
}

/** 提交的参考文件与已保存的是否一致（顺序、名称、大小和内容都相同）。 */
export function sameReferenceFiles(existing: readonly AssetFileRecord[], incoming: readonly NewAssetFile[]): boolean {
  const next = incoming.filter((file) => file.role === 'reference');
  return (
    existing.length === next.length &&
    existing.every((file, index) => file.fileName === next[index].fileName && file.content.equals(next[index].content))
  );
}

/**
 * 计算保存时的修订信息。
 * @param previous 保存前的资产。
 * @param next 提交的新内容。
 * @param filesChanged 参考文件是否被手动改动。
 */
export function computeRevisionUpdate(previous: AssetRecord, next: AssetContent, filesChanged: boolean): AssetRevisionUpdate {
  // 提示词不随表单保存而改变，修订号保持原样；手动改提示词见 computePromptRevision。
  return {
    contentRevision: previous.contentRevision + (contentFieldsChanged(previous, next) ? 1 : 0),
    promptRevision: previous.promptRevision,
    promptContentRevision: previous.promptContentRevision,
    clearAdopted: filesChanged
  };
}

/** 手动保存提示词时要写入的修订信息。 */
export interface PromptRevisionUpdate {
  readonly promptRevision: number;
  readonly promptContentRevision: number;
}

/**
 * 计算手动保存提示词的修订信息：文本有变化才增加修订号；用户亲自保存即视为已确认基于当前表单内容（文本没变也一样），清空则不再有依据。
 * @param previous 保存前的资产。
 * @param next 提交的提示词。
 */
export function computePromptRevision(
  previous: Pick<AssetRecord, 'promptZh' | 'promptEn' | 'promptRevision' | 'contentRevision'>,
  next: { readonly promptZh: string; readonly promptEn: string }
): PromptRevisionUpdate {
  const changed = previous.promptZh !== next.promptZh || previous.promptEn !== next.promptEn;
  return {
    promptRevision: previous.promptRevision + (changed ? 1 : 0),
    promptContentRevision: next.promptZh !== '' || next.promptEn !== '' ? previous.contentRevision : 0
  };
}

/** 是否有提示词。 */
export function hasPrompt(asset: Pick<AssetRecord, 'promptZh' | 'promptEn'>): boolean {
  return asset.promptZh !== '' || asset.promptEn !== '';
}

/** 提示词是否需要更新：有提示词，且表单字段在提示词之后改过。 */
export function isPromptOutdated(asset: Pick<AssetRecord, 'promptZh' | 'promptEn' | 'promptContentRevision' | 'contentRevision'>): boolean {
  return hasPrompt(asset) && asset.promptContentRevision < asset.contentRevision;
}

/** 图片（音频）是否有改动未生成：已有版本，且最新版本记录的修订号落后于资产现在的。 */
export function hasUngeneratedChanges(
  asset: Pick<AssetRecord, 'contentRevision' | 'promptRevision'>,
  summary: AssetGenerationSummary
): boolean {
  const latest = summary.latest;
  return latest !== null && (latest.contentRevision < asset.contentRevision || latest.promptRevision < asset.promptRevision);
}

/** 能否提交生成的判断结果；不能时 reason 说明原因。 */
export interface GenerationAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * 判断能否提交图片（音频）生成。
 * @param asset 资产。
 * @param summary 版本摘要。
 * @param hasUsableModel 是否有可用的同类型模型。
 */
export function checkGenerationAvailability(
  asset: Pick<AssetRecord, 'kind' | 'promptZh' | 'promptEn' | 'promptStatus'>,
  summary: AssetGenerationSummary,
  hasUsableModel: boolean
): GenerationAvailability {
  const noun = asset.kind === 'audio' ? '音频' : '图像';
  if (asset.promptStatus === 'running') {
    return { available: false, reason: '提示词生成中，完成后才能生成。' };
  }
  if (!hasPrompt(asset)) {
    return { available: false, reason: '请先生成或填写提示词。' };
  }
  if (summary.latest !== null && (summary.latest.status === 'queued' || summary.latest.status === 'running')) {
    return { available: false, reason: '正在生成，请等待完成或取消。' };
  }
  if (!hasUsableModel) {
    return { available: false, reason: `请先在“设置 > 模型”中启用${noun}模型并配置访问密钥。` };
  }
  return { available: true, reason: null };
}
