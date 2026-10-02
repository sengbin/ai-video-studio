// ------------------------------------------------------------------------
// 名称：generation-profile-rules.ts
// 说明：生成参数的规则：读取并校验修改请求、把修改应用到已保存的值、按“本集 → 作品 → 项目默认”合并出生效参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数；是否落在所选模型的能力范围内不在这里校验（超出范围由界面标红、提交时按能力校验）。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { EffectiveProfile, PROFILE_FIELDS, ProfileSource, ProfileValues } from '../models/generation-profile';
import { FieldErrors, assertNoFieldErrors, readRecord } from './field-readers';

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
  assertNoFieldErrors(errors);
  if (Object.keys(changes).length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有要修改的参数。' });
  }
  return changes;
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
 * @param work 作品级值。
 * @param episode 集级值。
 * @param project 项目默认值。
 */
export function resolveProfile(work: ProfileValues, episode: ProfileValues, project: ProjectProfileDefaults): EffectiveProfile {
  const modelId = pick(episode.modelId, work.modelId, null);
  const aspectRatio = pick(episode.aspectRatio, work.aspectRatio, project.aspectRatio);
  const resolution = pick(episode.resolution, work.resolution, project.resolution);
  const audioMode = pick(episode.audioMode, work.audioMode, null);
  return {
    values: { modelId: modelId.value, aspectRatio: aspectRatio.value, resolution: resolution.value, audioMode: audioMode.value },
    sources: { modelId: modelId.source, aspectRatio: aspectRatio.source, resolution: resolution.source, audioMode: audioMode.source }
  };
}
