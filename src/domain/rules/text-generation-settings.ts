// ------------------------------------------------------------------------
// 名称：text-generation-settings.ts
// 说明：文本生成设置的规范化：是否启用 Copilot、全局默认文本模型、小说分段方式与每段字数上限。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：设置来自用户可自由编辑的 VS Code 设置，不可信；不合法的值回退为默认值或夹到允许范围内。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { NovelSplitMode, NovelSplitSettings } from './novel-splitter';
import { TEXT_MODEL_KEY_MAX_LENGTH, copilotModelKey, parseTextModelKey } from './text-model-selection';

/** 每段字数上限的允许范围与默认值。 */
export const SEGMENT_CHARS_MIN = 2000;
export const SEGMENT_CHARS_MAX = 100000;
export const DEFAULT_SEGMENT_CHARS = 20000;
export const DEFAULT_SPLIT_MODE: NovelSplitMode = 'chapter';
/** 默认启用 Copilot，已有用户升级后行为不变。 */
export const DEFAULT_COPILOT_ENABLED = true;

/** 文本生成设置。 */
export interface TextGenerationSettings {
  /** 是否启用 VS Code 内置的 Copilot：关闭后 Copilot 的模型不再出现在文本模型选择列表中。 */
  readonly copilotEnabled: boolean;
  /** 全局默认文本模型的键（见 text-model-selection.ts）；作品没有单独选择时使用。 */
  readonly defaultModel: string;
  readonly novelSplit: NovelSplitSettings;
}

/** 从设置中读到的原始值，类型未知。 */
export interface RawTextGenerationSettings {
  readonly copilotEnabled?: unknown;
  readonly defaultModel?: unknown;
  /** 旧版的 Copilot 模型家族；没有设置默认模型时按它推出默认值。 */
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
  const legacyFamily = typeof raw.modelFamily === 'string' ? raw.modelFamily.trim() : '';
  const configuredModel = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '';
  const defaultModel = parseTextModelKey(configuredModel) === undefined ? copilotModelKey(legacyFamily) : configuredModel;
  const mode: NovelSplitMode = raw.splitMode === 'length' || raw.splitMode === 'chapter' ? raw.splitMode : DEFAULT_SPLIT_MODE;
  const maxSegmentChars =
    typeof raw.maxSegmentChars === 'number' && Number.isFinite(raw.maxSegmentChars)
      ? Math.min(SEGMENT_CHARS_MAX, Math.max(SEGMENT_CHARS_MIN, Math.floor(raw.maxSegmentChars)))
      : DEFAULT_SEGMENT_CHARS;
  return { copilotEnabled, defaultModel, novelSplit: { mode, maxSegmentChars } };
}

/** 对文本生成设置的一次修改，只包含要改的项，已经过校验。 */
export interface TextGenerationSettingsPatch {
  readonly copilotEnabled?: boolean;
  readonly defaultModel?: string;
  readonly splitMode?: NovelSplitMode;
  readonly maxSegmentChars?: number;
}

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
      errors.copilotEnabled = '是否启用 Copilot 必须是开或关。';
    }
  }
  if (source.defaultModel !== undefined) {
    const key = typeof source.defaultModel === 'string' ? source.defaultModel.trim() : '';
    if (key.length > TEXT_MODEL_KEY_MAX_LENGTH || parseTextModelKey(key) === undefined) {
      errors.defaultModel = '默认文本模型无效，请从列表中选择。';
    } else {
      patch.defaultModel = key;
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