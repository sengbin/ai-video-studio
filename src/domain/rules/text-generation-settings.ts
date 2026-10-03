// ------------------------------------------------------------------------
// 名称：text-generation-settings.ts
// 说明：文本生成设置的规范化：是否使用 Copilot、Copilot 模型家族、小说分段方式与每段字数上限。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：设置来自用户可自由编辑的 VS Code 设置，不可信；不合法的值回退为默认值或夹到允许范围内。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { NovelSplitMode, NovelSplitSettings } from './novel-splitter';

/** 每段字数上限的允许范围与默认值。 */
export const SEGMENT_CHARS_MIN = 2000;
export const SEGMENT_CHARS_MAX = 100000;
export const DEFAULT_SEGMENT_CHARS = 20000;
export const DEFAULT_SPLIT_MODE: NovelSplitMode = 'chapter';
/** 默认使用 Copilot 生成文本，已有用户升级后行为不变。 */
export const DEFAULT_COPILOT_ENABLED = true;

/** 文本生成设置。 */
export interface TextGenerationSettings {
  /** 是否使用 VS Code 内置的 Copilot 生成文本；为 false 时使用千问AI平台的文本模型。 */
  readonly copilotEnabled: boolean;
  /** Copilot 模型家族；空串表示自动选择。 */
  readonly modelFamily: string;
  readonly novelSplit: NovelSplitSettings;
}

/** 从设置中读到的原始值，类型未知。 */
export interface RawTextGenerationSettings {
  readonly copilotEnabled?: unknown;
  readonly modelFamily?: unknown;
  readonly splitMode?: unknown;
  readonly maxSegmentChars?: unknown;
}

/**
 * 把原始设置整理为可用的设置。
 * @param raw 从 VS Code 设置读到的值。
 */
export function normalizeTextGenerationSettings(raw: RawTextGenerationSettings): TextGenerationSettings {
  const copilotEnabled = typeof raw.copilotEnabled === 'boolean' ? raw.copilotEnabled : DEFAULT_COPILOT_ENABLED;
  const modelFamily = typeof raw.modelFamily === 'string' ? raw.modelFamily.trim() : '';
  const mode: NovelSplitMode = raw.splitMode === 'length' || raw.splitMode === 'chapter' ? raw.splitMode : DEFAULT_SPLIT_MODE;
  const maxSegmentChars =
    typeof raw.maxSegmentChars === 'number' && Number.isFinite(raw.maxSegmentChars)
      ? Math.min(SEGMENT_CHARS_MAX, Math.max(SEGMENT_CHARS_MIN, Math.floor(raw.maxSegmentChars)))
      : DEFAULT_SEGMENT_CHARS;
  return { copilotEnabled, modelFamily, novelSplit: { mode, maxSegmentChars } };
}

/** 对文本生成设置的一次修改，只包含要改的项，已经过校验。 */
export interface TextGenerationSettingsPatch {
  readonly copilotEnabled?: boolean;
  readonly modelFamily?: string;
  readonly splitMode?: NovelSplitMode;
  readonly maxSegmentChars?: number;
}

/** 模型家族名称的最大长度。 */
export const MODEL_FAMILY_MAX_LENGTH = 100;

/**
 * 校验设置页提交的修改：与读取时“回退默认值”不同，这里不合法的值直接拒绝，让用户知道没有保存。
 * @param rawInput 界面提交的原始内容，只处理出现的键。
 * @throws ValidationError 存在不合法的值，或没有任何要修改的项。
 */
export function normalizeTextGenerationSettingsPatch(rawInput: unknown): TextGenerationSettingsPatch {
  if (typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '提交内容格式不正确。' });
  }
  const source = rawInput as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const patch: { -readonly [K in keyof TextGenerationSettingsPatch]: TextGenerationSettingsPatch[K] } = {};

  if (source.copilotEnabled !== undefined) {
    if (typeof source.copilotEnabled === 'boolean') {
      patch.copilotEnabled = source.copilotEnabled;
    } else {
      errors.copilotEnabled = '是否使用 Copilot 必须是开或关。';
    }
  }
  if (source.modelFamily !== undefined) {
    if (typeof source.modelFamily !== 'string' || source.modelFamily.trim().length > MODEL_FAMILY_MAX_LENGTH) {
      errors.modelFamily = `Copilot 模型必须是不超过 ${MODEL_FAMILY_MAX_LENGTH} 字的文本。`;
    } else {
      patch.modelFamily = source.modelFamily.trim();
    }
  }
  if (source.splitMode !== undefined) {
    if (source.splitMode === 'chapter' || source.splitMode === 'length') {
      patch.splitMode = source.splitMode;
    } else {
      errors.splitMode = '小说分段方式必须是“按章节”或“按字数”。';
    }
  }
  if (source.maxSegmentChars !== undefined) {
    const value = source.maxSegmentChars;
    if (typeof value === 'number' && Number.isInteger(value) && value >= SEGMENT_CHARS_MIN && value <= SEGMENT_CHARS_MAX) {
      patch.maxSegmentChars = value;
    } else {
      errors.maxSegmentChars = `每段字数上限必须是 ${SEGMENT_CHARS_MIN} 到 ${SEGMENT_CHARS_MAX} 之间的整数。`;
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有需要保存的设置。' });
  }
  return patch;
}