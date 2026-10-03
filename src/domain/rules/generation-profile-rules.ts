// ------------------------------------------------------------------------
// 名称：generation-profile-rules.ts
// 说明：生成参数的规则：读取并校验修改请求、检查字段能否在所选范围保存、把修改应用到已保存的值、按“本集 → 作品 → 项目默认”合并出生效参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数；是否落在所选模型的能力范围内不在这里校验（超出范围由界面标红、提交时按能力校验）。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import {
  EffectiveProfile,
  GROUP_DURATION_MAX_SECONDS,
  GROUP_ONLY_FIELDS,
  NEGATIVE_LIST_MAX_LENGTH,
  PROFILE_FIELDS,
  ProfileScope,
  ProfileSource,
  ProfileValues,
  SEED_MAX
} from '../models/generation-profile';
import { VIDEO_AUDIO_ELEMENTS, VideoAudioElement } from '../models/model-capability';
import { FieldErrors, assertNoFieldErrors, readRecord } from './field-readers';

/** 只能在镜头组范围保存的字段的界面名称，用于报错说明。 */
const GROUP_ONLY_FIELD_LABELS: Readonly<Record<string, string>> = { durationSeconds: '生成时长' };

/** 声音内容、随机种子不合法时的说明，提交请求与保存参数共用。 */
export const AUDIO_ELEMENTS_ERROR_TEXT = '声音内容不合法，请从对白、旁白、音效、配乐中至少选择一项；不需要声音时请把声音模式设为无声。';
export const SEED_ERROR_TEXT = `随机种子必须是 0 到 ${SEED_MAX} 之间的整数。`;
/** 负向清单、提示词改写不合法时的说明。 */
export const NEGATIVE_LIST_ERROR_TEXT = `负向清单必须是不超过 ${NEGATIVE_LIST_MAX_LENGTH} 字的文本。`;
export const PROMPT_EXTEND_ERROR_TEXT = '提示词改写只能是开启或关闭。';

/** 画幅、分辨率的最大长度。 */
const PARAM_TEXT_MAX_LENGTH = 20;

/** 一次修改：值为新值，null 表示恢复继承；没有出现的字段不变。 */
export type ProfileChanges = Partial<ProfileValues>;

/** 项目级默认值。 */
export interface ProjectProfileDefaults {
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
}

/** 空串按“恢复继承”处理。 */
function emptyToNull(value: unknown): unknown {
  return value === '' ? null : value;
}

/**
 * 读取并校验参数修改请求。
 * @param rawChanges 界面提交的 changes 对象。
 * @throws ValidationError 字段名未知、没有任何修改，或值不合法。
 */
export function readProfileChanges(rawChanges: unknown): ProfileChanges {
  const source = readRecord(rawChanges);
  const errors: FieldErrors = {};
  const changes: { -readonly [K in keyof ProfileValues]?: ProfileValues[K] } = {};
  for (const key of Object.keys(source)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
      errors[FORM_LEVEL_ERROR_KEY] = `未知的参数：${key}。`;
    }
  }
  if (source.modelId !== undefined) {
    const modelId = emptyToNull(source.modelId);
    if (modelId === null || (typeof modelId === 'number' && Number.isInteger(modelId))) {
      changes.modelId = modelId;
    } else {
      errors.modelId = '模型标识无效。';
    }
  }
  for (const [key, label] of [['aspectRatio', '画幅'], ['resolution', '分辨率']] as const) {
    if (source[key] === undefined) continue;
    const text = emptyToNull(source[key]);
    if (text === null || (typeof text === 'string' && text.length <= PARAM_TEXT_MAX_LENGTH)) {
      changes[key] = text;
    } else {
      errors[key] = `${label}不合法。`;
    }
  }
  if (source.audioMode !== undefined) {
    const mode = emptyToNull(source.audioMode);
    if (mode === null || mode === 'none' || mode === 'native') {
      changes.audioMode = mode;
    } else {
      errors.audioMode = '声音模式不合法。';
    }
  }
  if (source.audioElements !== undefined) {
    const elements = readAudioElements(emptyToNull(source.audioElements));
    if (elements === undefined) {
      errors.audioElements = AUDIO_ELEMENTS_ERROR_TEXT;
    } else {
      changes.audioElements = elements;
    }
  }
  if (source.seed !== undefined) {
    const seed = emptyToNull(source.seed);
    if (seed === null || isValidSeed(seed)) {
      changes.seed = seed;
    } else {
      errors.seed = SEED_ERROR_TEXT;
    }
  }
  if (source.durationSeconds !== undefined) {
    const seconds = emptyToNull(source.durationSeconds);
    if (seconds === null || (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= GROUP_DURATION_MAX_SECONDS)) {
      changes.durationSeconds = seconds;
    } else {
      errors.durationSeconds = `生成时长必须是大于 0 且不超过 ${GROUP_DURATION_MAX_SECONDS} 秒的数字。`;
    }
  }
  if (source.negativeList !== undefined) {
    // 与其他字段不同，空串是有效值（明确不要负向清单），恢复继承用 null。
    const list = readNegativeList(source.negativeList);
    if (list === undefined) {
      errors.negativeList = NEGATIVE_LIST_ERROR_TEXT;
    } else {
      changes.negativeList = list;
    }
  }
  if (source.promptExtend !== undefined) {
    const extend = emptyToNull(source.promptExtend);
    if (extend === null || typeof extend === 'boolean') {
      changes.promptExtend = extend;
    } else {
      errors.promptExtend = PROMPT_EXTEND_ERROR_TEXT;
    }
  }
  assertNoFieldErrors(errors);
  if (Object.keys(changes).length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有要修改的参数。' });
  }
  return changes;
}

/**
 * 读取声音内容：null 原样返回（恢复继承）；数组去重并按固定顺序排列，必须至少一项且每项都是已知的声音内容。
 * @param value 界面提交的值。
 * @returns 规范化后的声音内容；不合法时为 undefined。
 */
export function readAudioElements(value: unknown): readonly VideoAudioElement[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => (VIDEO_AUDIO_ELEMENTS as readonly unknown[]).includes(item))) {
    return undefined;
  }
  return VIDEO_AUDIO_ELEMENTS.filter((element) => value.includes(element));
}

/**
 * 读取负向清单：null 原样返回（恢复继承）；文本去掉首尾空白，可以为空串，不得超过长度上限。
 * @returns 规范化后的清单；不合法时为 undefined。
 */
export function readNegativeList(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > NEGATIVE_LIST_MAX_LENGTH ? undefined : text;
}

/** 值是否是合法的随机种子：0 至 SEED_MAX 的整数。 */
export function isValidSeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SEED_MAX;
}

/**
 * 检查修改里的字段能否保存在该范围：生成时长只能按镜头组设置。
 * @param scope 要保存的范围。
 * @param changes 已校验的修改。
 * @throws ValidationError 作品、集范围的修改里含有只能按镜头组设置的字段。
 */
export function assertChangesAllowedInScope(scope: ProfileScope, changes: ProfileChanges): void {
  if (scope === 'group') return;
  const errors: FieldErrors = {};
  for (const field of GROUP_ONLY_FIELDS) {
    if (changes[field] !== undefined) {
      errors[field] = `${GROUP_ONLY_FIELD_LABELS[field]}只能按镜头组设置。`;
    }
  }
  assertNoFieldErrors(errors);
}

/** 把修改应用到已保存的值，返回新值。 */
export function applyProfileChanges(current: ProfileValues, changes: ProfileChanges): ProfileValues {
  return { ...current, ...changes };
}

/** 依次取本集、作品、项目默认中第一个非空值，并记录来源。 */
function pick<T>(episode: T | null, work: T | null, project: T | null): { readonly value: T | null; readonly source: ProfileSource } {
  if (episode !== null) return { value: episode, source: 'episode' };
  if (work !== null) return { value: work, source: 'work' };
  if (project !== null) return { value: project, source: 'project' };
  return { value: null, source: 'none' };
}

/**
 * 合并出生效参数：每个字段依次取本集、作品的值，画幅与分辨率最后回退到项目默认值，并记录来源。
 * 本组生成时长只能按镜头组设置，这里恒为空、来源为 none；镜头组覆盖由调用方按“本组优先”再叠加。
 * @param work 作品级值。
 * @param episode 集级值。
 * @param project 项目默认值。
 */
export function resolveProfile(work: ProfileValues, episode: ProfileValues, project: ProjectProfileDefaults): EffectiveProfile {
  const modelId = pick(episode.modelId, work.modelId, null);
  const aspectRatio = pick(episode.aspectRatio, work.aspectRatio, project.aspectRatio);
  const resolution = pick(episode.resolution, work.resolution, project.resolution);
  const audioMode = pick(episode.audioMode, work.audioMode, null);
  const audioElements = pick(episode.audioElements, work.audioElements, null);
  const seed = pick(episode.seed, work.seed, null);
  const negativeList = pick(episode.negativeList, work.negativeList, null);
  const promptExtend = pick(episode.promptExtend, work.promptExtend, null);
  return {
    values: {
      modelId: modelId.value,
      aspectRatio: aspectRatio.value,
      resolution: resolution.value,
      audioMode: audioMode.value,
      audioElements: audioElements.value,
      seed: seed.value,
      durationSeconds: null,
      negativeList: negativeList.value,
      promptExtend: promptExtend.value
    },
    sources: {
      modelId: modelId.source,
      aspectRatio: aspectRatio.source,
      resolution: resolution.source,
      audioMode: audioMode.source,
      audioElements: audioElements.source,
      seed: seed.source,
      durationSeconds: 'none',
      negativeList: negativeList.source,
      promptExtend: promptExtend.source
    }
  };
}
