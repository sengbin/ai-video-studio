// ------------------------------------------------------------------------
// 名称：text-generation-settings.ts
// 说明：文本生成设置的规范化：Copilot 模型家族、小说分段方式与每段字数上限。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：设置来自用户可自由编辑的 VS Code 设置，不可信；不合法的值回退为默认值或夹到允许范围内。
// ------------------------------------------------------------------------

import { NovelSplitMode, NovelSplitSettings } from './novel-splitter';

/** 每段字数上限的允许范围与默认值。 */
export const SEGMENT_CHARS_MIN = 2000;
export const SEGMENT_CHARS_MAX = 100000;
export const DEFAULT_SEGMENT_CHARS = 20000;
export const DEFAULT_SPLIT_MODE: NovelSplitMode = 'chapter';

/** 文本生成设置。 */
export interface TextGenerationSettings {
  /** Copilot 模型家族；空串表示自动选择。 */
  readonly modelFamily: string;
  readonly novelSplit: NovelSplitSettings;
}

/** 从设置中读到的原始值，类型未知。 */
export interface RawTextGenerationSettings {
  readonly modelFamily?: unknown;
  readonly splitMode?: unknown;
  readonly maxSegmentChars?: unknown;
}

/**
 * 把原始设置整理为可用的设置。
 * @param raw 从 VS Code 设置读到的值。
 */
export function normalizeTextGenerationSettings(raw: RawTextGenerationSettings): TextGenerationSettings {
  const modelFamily = typeof raw.modelFamily === 'string' ? raw.modelFamily.trim() : '';
  const mode: NovelSplitMode = raw.splitMode === 'length' || raw.splitMode === 'chapter' ? raw.splitMode : DEFAULT_SPLIT_MODE;
  const maxSegmentChars =
    typeof raw.maxSegmentChars === 'number' && Number.isFinite(raw.maxSegmentChars)
      ? Math.min(SEGMENT_CHARS_MAX, Math.max(SEGMENT_CHARS_MIN, Math.floor(raw.maxSegmentChars)))
      : DEFAULT_SEGMENT_CHARS;
  return { modelFamily, novelSplit: { mode, maxSegmentChars } };
}
