// ------------------------------------------------------------------------
// 名称：storyboard-rules.ts
// 说明：分镜脚本阶段的规则：生成参数校验、镜头与声音的输出校验（实体按名称映射为标识）、用户编辑镜头时的校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：输出校验失败抛出 GeneratedOutputError，由阶段记录为失败并保留原始输出；界面提交的编辑内容校验失败抛出 ValidationError。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';
import { ENTITY_KIND_LABELS, EntityKind } from '../models/screenplay';
import {
  AudioMode,
  ContinuityStrategy,
  FirstFrameMode,
  SOUND_KIND_LABELS,
  ShotDraft,
  ShotEdit,
  SoundDraft,
  SoundKind,
  StoryboardEntity,
  StoryboardParams
} from '../models/storyboard';
import {
  FieldErrors,
  assertNoFieldErrors,
  readOptionalChoice,
  readOptionalDecimal,
  readInteger,
  readOptionalText,
  readRecord,
  readText
} from './field-readers';
import { DEFAULT_GROUP_MAX_SECONDS, GROUP_SECONDS_MAX, GROUP_SECONDS_MIN, groupMaxSecondsOf } from './shot-group-rules';

/** 镜头总数上限的取值范围；不填时取最大值。 */
export const MAX_SHOTS_LIMIT = 200;
/** 单镜头时长的取值范围（秒）。 */
export const SHOT_SECONDS_MIN = 0.1;
export const SHOT_SECONDS_MAX = 600;

export const STORYBOARD_EXTRA_MAX_LENGTH = 2000;
export const STORYBOARD_STYLE_MAX_LENGTH = 50;
export const SHOT_LABEL_MAX_LENGTH = 100;
export const SHOT_ACTION_MAX_LENGTH = 1000;
export const SHOT_NOTE_MAX_LENGTH = 500;
export const SHOT_PROMPT_MAX_LENGTH = 2000;
export const SOUND_TEXT_MAX_LENGTH = 500;
export const SOUND_DELIVERY_MAX_LENGTH = 200;
/** 一个镜头最多的声音条目数。 */
export const MAX_SOUNDS_PER_SHOT = 20;

/** 连贯策略、声音模式的选项，界面显示文字与键一一对应。 */
export const CONTINUITY_LABELS: Readonly<Record<ContinuityStrategy, string>> = {
  none: '无',
  prev_tail: '尾帧接首帧',
  ai: '由 AI 判断'
};
export const AUDIO_MODE_LABELS: Readonly<Record<AudioMode, string>> = {
  none: '无声',
  native: '模型原生生成'
};

const SOUND_KINDS = Object.keys(SOUND_KIND_LABELS) as SoundKind[];
const ENTITY_KINDS = Object.keys(ENTITY_KIND_LABELS) as EntityKind[];

/** 生成分镜脚本时需要的信息：生成参数、可引用的实体。 */
export interface StoryboardContext {
  readonly params: StoryboardParams;
  readonly entities: readonly StoryboardEntity[];
  /** 本集全部镜头的总时长上限（秒），来自本集目标时长；不填表示不限制。 */
  readonly maxTotalSeconds?: number | null;
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取模型返回的文本字段并去除首尾空白；不是文本时按空串处理。 */
function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** 读取声音类型列表：数组，或表单传来的 JSON 数组文本。 */
function readSoundKinds(value: unknown, errors: FieldErrors): SoundKind[] {
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = value.trim() === '' ? [] : JSON.parse(value);
    } catch {
      list = null;
    }
  }
  if (list === undefined || list === null) {
    return [];
  }
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    errors.audioElements = '声音内容格式不正确。';
    return [];
  }
  const labelToKind = new Map(SOUND_KINDS.map((kind) => [SOUND_KIND_LABELS[kind], kind]));
  const kinds: SoundKind[] = [];
  for (const item of list as string[]) {
    // 表单提交的是界面文字，宿主内部使用键，两种写法都接受。
    const kind = SOUND_KINDS.includes(item as SoundKind) ? (item as SoundKind) : labelToKind.get(item);
    if (kind === undefined) {
      errors.audioElements = `声音内容必须是以下之一：${SOUND_KINDS.map((key) => SOUND_KIND_LABELS[key]).join('、')}。`;
      return [];
    }
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return SOUND_KINDS.filter((kind) => kinds.includes(kind));
}

/** 读取选项：界面文字或键都接受；缺省取默认值。 */
function readLabeledChoice<T extends string>(
  source: Record<string, unknown>,
  key: string,
  label: string,
  labels: Readonly<Record<T, string>>,
  fallback: T,
  errors: FieldErrors
): T {
  const keys = Object.keys(labels) as T[];
  const raw = source[key];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const matched = typeof raw === 'string' ? keys.find((item) => item === raw || labels[item] === raw) : undefined;
  if (matched === undefined) {
    errors[key] = `${label}必须是以下之一：${keys.map((item) => labels[item]).join('、')}。`;
    return fallback;
  }
  return matched;
}

/**
 * 校验并规范化分镜脚本阶段的生成参数（F5 中影响生成的字段）。
 * @param rawInput 界面提交的原始内容，数字字段可以是数字或文本。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeStoryboardParams(rawInput: unknown): StoryboardParams {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const visualStyle = readOptionalText(
    source,
    { key: 'visualStyle', label: '画面风格', required: false, maxLength: STORYBOARD_STYLE_MAX_LENGTH },
    errors
  );
  const decimal = { min: SHOT_SECONDS_MIN, max: SHOT_SECONDS_MAX, maxDecimals: 1 };
  const minShotSeconds = readOptionalDecimal(source, { key: 'minShotSeconds', label: '单镜头最短时长', ...decimal }, errors);
  const maxShotSeconds = readOptionalDecimal(source, { key: 'maxShotSeconds', label: '单镜头最长时长', ...decimal }, errors);
  if (minShotSeconds !== null && maxShotSeconds !== null && maxShotSeconds < minShotSeconds) {
    errors.maxShotSeconds = '单镜头最长时长不能小于最短时长。';
  }
  const rawGroupMax = source.groupMaxSeconds;
  const hasGroupMax = !(rawGroupMax === undefined || rawGroupMax === null || (typeof rawGroupMax === 'string' && rawGroupMax.trim() === ''));
  const groupMaxSeconds = hasGroupMax
    ? readInteger(source, { key: 'groupMaxSeconds', label: '单组最长时长', required: true, min: GROUP_SECONDS_MIN, max: GROUP_SECONDS_MAX }, errors)
    : DEFAULT_GROUP_MAX_SECONDS;
  if (errors.groupMaxSeconds === undefined) {
    if (maxShotSeconds !== null && maxShotSeconds > groupMaxSeconds && errors.maxShotSeconds === undefined) {
      errors.maxShotSeconds = `单镜头最长时长不能大于单组最长时长（${groupMaxSeconds} 秒），一个镜头必须能放进一组。`;
    }
    if (minShotSeconds !== null && minShotSeconds > groupMaxSeconds && errors.minShotSeconds === undefined) {
      errors.minShotSeconds = `单镜头最短时长不能大于单组最长时长（${groupMaxSeconds} 秒）。`;
    }
  }
  const rawMaxShots = source.maxShots;
  const hasMaxShots = !(rawMaxShots === undefined || rawMaxShots === null || (typeof rawMaxShots === 'string' && rawMaxShots.trim() === ''));
  const maxShots = hasMaxShots
    ? readInteger(source, { key: 'maxShots', label: '镜头总数上限', required: true, min: 1, max: MAX_SHOTS_LIMIT }, errors)
    : null;
  const continuity = readLabeledChoice<ContinuityStrategy>(source, 'continuity', '镜头连贯策略', CONTINUITY_LABELS, 'ai', errors);
  const audioMode = readLabeledChoice<AudioMode>(source, 'audioMode', '声音模式', AUDIO_MODE_LABELS, 'native', errors);
  const elements = source.audioElements === undefined ? [...SOUND_KINDS] : readSoundKinds(source.audioElements, errors);
  if (audioMode !== 'none' && elements.length === 0 && errors.audioElements === undefined) {
    errors.audioElements = '请至少选择一项声音内容。';
  }
  const extra = readOptionalText(
    source,
    { key: 'extra', label: '补充要求', required: false, maxLength: STORYBOARD_EXTRA_MAX_LENGTH },
    errors
  );
  assertNoFieldErrors(errors);
  return {
    visualStyle,
    minShotSeconds,
    maxShotSeconds,
    groupMaxSeconds,
    maxShots,
    continuity,
    audioMode,
    audioElements: audioMode === 'none' ? [] : elements,
    extra
  };
}

/** 在可引用的实体中按（类型，名称或别名）查找；名称优先于别名。 */
function resolveEntity(entities: readonly StoryboardEntity[], kind: EntityKind, name: string): StoryboardEntity | undefined {
  return (
    entities.find((entity) => entity.kind === kind && entity.name === name) ??
    entities.find((entity) => entity.kind === kind && entity.aliases.includes(name))
  );
}

/** 读取一个文本字段并校验长度，必填时不能为空；name 是提示中使用的字段名，默认用键。 */
function readShotText(
  record: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
  required: boolean,
  issues: string[],
  name: string = key
): string {
  const value = textOf(record, key);
  if (required && value.length === 0) {
    issues.push(`${label}的 ${name} 不能为空。`);
  } else if (value.length > max) {
    issues.push(`${label}的 ${name} 不能超过 ${max} 字。`);
  }
  return value;
}

/** 读取可选的秒数（数字，或界面提交的数字文本，空文本视为未填）；不是数字或超出范围时记录问题。 */
function readSeconds(raw: unknown, field: string, label: string, positive: boolean, issues: string[]): number | null {
  const value = typeof raw === 'string' ? (raw.trim() === '' ? null : /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : raw) : raw;
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value <= 0) || value > SHOT_SECONDS_MAX) {
    issues.push(`${label}的 ${field} 必须是${positive ? '大于 0' : '不小于 0'}且不超过 ${SHOT_SECONDS_MAX} 的数字。`);
    return null;
  }
  return value;
}

/** 解析一个实体引用：{ kind, name }。 */
function parseEntityRef(
  item: unknown,
  entities: readonly StoryboardEntity[],
  label: string,
  issues: string[]
): StoryboardEntity | undefined {
  const record = isRecord(item) ? item : {};
  const kind = record.kind;
  const name = textOf(record, 'name');
  if (typeof kind !== 'string' || !ENTITY_KINDS.includes(kind as EntityKind) || name.length === 0) {
    issues.push(`${label}的 entities 每项必须包含 kind（${ENTITY_KINDS.join('、')}）和 name。`);
    return undefined;
  }
  const entity = resolveEntity(entities, kind as EntityKind, name);
  if (entity === undefined) {
    issues.push(`${label}引用了不存在的${ENTITY_KIND_LABELS[kind as EntityKind]}“${name}”，只能引用剧本中已有的实体。`);
  }
  return entity;
}

/** 解析一个镜头的声音条目；声音模式为无声时忽略。 */
function parseSounds(
  value: unknown,
  context: StoryboardContext,
  label: string,
  entityIds: Set<number>,
  issues: string[]
): SoundDraft[] {
  const { params, entities } = context;
  if (params.audioMode === 'none' || value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${label}的 sounds 必须是数组。`);
    return [];
  }
  if (value.length > MAX_SOUNDS_PER_SHOT) {
    issues.push(`${label}的声音条目不能超过 ${MAX_SOUNDS_PER_SHOT} 条。`);
    return [];
  }
  const sounds: SoundDraft[] = [];
  value.forEach((item, index) => {
    const soundLabel = `${label}的第 ${index + 1} 条声音`;
    const record = isRecord(item) ? item : {};
    const kind = record.kind;
    if (typeof kind !== 'string' || !params.audioElements.includes(kind as SoundKind)) {
      issues.push(`${soundLabel}的 kind 必须是以下之一：${params.audioElements.join('、')}。`);
      return;
    }
    let speakerEntityId: number | null = null;
    if (kind === 'dialogue') {
      const speaker = textOf(record, 'speaker');
      const entity = speaker.length === 0 ? undefined : resolveEntity(entities, 'character', speaker);
      if (entity === undefined) {
        issues.push(`${soundLabel}的 speaker 必须是剧本中已有的角色名称。`);
        return;
      }
      speakerEntityId = entity.id;
      entityIds.add(entity.id);
    }
    const text = readShotText(record, 'text', soundLabel, SOUND_TEXT_MAX_LENGTH, true, issues);
    const delivery = readShotText(record, 'delivery', soundLabel, SOUND_DELIVERY_MAX_LENGTH, false, issues);
    sounds.push({
      kind: kind as SoundKind,
      speakerEntityId,
      text,
      delivery,
      startOffsetSeconds: readSeconds(record.startOffsetSeconds, 'startOffsetSeconds', soundLabel, false, issues),
      durationSeconds: readSeconds(record.durationSeconds, 'durationSeconds', soundLabel, true, issues),
      isEnabled: true
    });
  });
  return sounds;
}

/** 解析镜头的首帧来源：按连贯策略决定，由 AI 判断时读取模型给出的值。 */
function parseFirstFrame(record: Record<string, unknown>, seq: number, params: StoryboardParams, label: string, issues: string[]): FirstFrameMode {
  if (params.continuity === 'none' || seq === 1) {
    if (seq === 1 && params.continuity === 'ai' && record.firstFrameMode === 'prev_tail') {
      issues.push(`${label}是第 1 个镜头，没有上一镜头，firstFrameMode 不能是 prev_tail。`);
    }
    return 'none';
  }
  if (params.continuity === 'prev_tail') {
    return 'prev_tail';
  }
  const mode = record.firstFrameMode;
  if (mode === undefined || mode === null || mode === 'none') {
    return 'none';
  }
  if (mode !== 'prev_tail') {
    issues.push(`${label}的 firstFrameMode 必须是 none 或 prev_tail。`);
  }
  return 'prev_tail';
}

/** 解析并校验一个镜头；序号由顺序决定。 */
function parseShot(item: unknown, index: number, context: StoryboardContext, issues: string[]): ShotDraft {
  const { params, entities } = context;
  const seq = index + 1;
  const label = `第 ${seq} 个镜头`;
  const record = isRecord(item) ? item : {};

  const action = readShotText(record, 'action', label, SHOT_ACTION_MAX_LENGTH, true, issues);
  const sceneLabel = readShotText(record, 'sceneLabel', label, SHOT_LABEL_MAX_LENGTH, false, issues);
  const shotSize = readShotText(record, 'shotSize', label, SHOT_LABEL_MAX_LENGTH, false, issues);
  const cameraAngle = readShotText(record, 'cameraAngle', label, SHOT_LABEL_MAX_LENGTH, false, issues);
  const cameraMovement = readShotText(record, 'cameraMovement', label, SHOT_LABEL_MAX_LENGTH, false, issues);
  const transition = readShotText(record, 'transition', label, SHOT_LABEL_MAX_LENGTH, false, issues);
  const continuityNote = readShotText(record, 'continuityNote', label, SHOT_NOTE_MAX_LENGTH, false, issues);
  const promptZh = readShotText(record, 'promptZh', label, SHOT_PROMPT_MAX_LENGTH, true, issues);
  const promptEn = readShotText(record, 'promptEn', label, SHOT_PROMPT_MAX_LENGTH, true, issues);

  const minSeconds = params.minShotSeconds ?? SHOT_SECONDS_MIN;
  const maxSeconds = Math.min(params.maxShotSeconds ?? SHOT_SECONDS_MAX, groupMaxSecondsOf(params));
  const rawDuration = record.durationSeconds;
  let durationSeconds = minSeconds;
  if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration) || rawDuration < minSeconds || rawDuration > maxSeconds) {
    issues.push(`${label}的 durationSeconds 必须是 ${minSeconds} 到 ${maxSeconds} 之间的数字。`);
  } else {
    durationSeconds = rawDuration;
  }

  const entityIds = new Set<number>();
  const rawEntities = record.entities;
  if (rawEntities !== undefined && rawEntities !== null) {
    if (!Array.isArray(rawEntities)) {
      issues.push(`${label}的 entities 必须是数组。`);
    } else {
      for (const ref of rawEntities) {
        const entity = parseEntityRef(ref, entities, label, issues);
        if (entity !== undefined) {
          entityIds.add(entity.id);
        }
      }
    }
  }
  const sounds = parseSounds(record.sounds, context, label, entityIds, issues);

  return {
    seq,
    sceneLabel,
    shotSize,
    cameraAngle,
    action,
    cameraMovement,
    durationSeconds,
    transition,
    continuityNote,
    firstFrameMode: parseFirstFrame(record, seq, params, label, issues),
    entityIds: [...entityIds],
    sounds,
    promptZh,
    promptEn
  };
}

/**
 * 校验并整理模型生成的一集分镜脚本。
 * @param raw 模型提交的 { shots }。
 * @param context 生成参数与可引用的实体；镜头引用的实体按（类型，名称或别名）映射为实体标识。
 * @throws GeneratedOutputError 格式不对、镜头数超限、时长越界或引用了不存在的实体。
 */
export function parseStoryboard(raw: unknown, context: StoryboardContext): ShotDraft[] {
  if (!isRecord(raw) || !Array.isArray(raw.shots)) {
    throw new GeneratedOutputError(['结果必须是包含 shots 数组的对象。']);
  }
  const issues: string[] = [];
  const limit = context.params.maxShots ?? MAX_SHOTS_LIMIT;
  if (raw.shots.length === 0) {
    issues.push('shots 至少需要 1 个镜头。');
  } else if (raw.shots.length > limit) {
    issues.push(`shots 有 ${raw.shots.length} 个，超过上限 ${limit} 个，请合并或精简镜头。`);
  }
  const shots = raw.shots.slice(0, limit).map((item, index) => parseShot(item, index, context, issues));
  const maxTotal = context.maxTotalSeconds ?? null;
  if (maxTotal !== null && issues.length === 0) {
    // 保留一位小数，避免浮点累加误差误判。
    const total = Math.round(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 10) / 10;
    if (total > maxTotal) {
      issues.push(`所有镜头总时长 ${total} 秒，超过本集目标时长 ${maxTotal} 秒，请减少镜头或缩短镜头时长。`);
    }
  }
  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return shots;
}

/** 读取用户编辑的声音条目。 */
function readSoundEdits(value: unknown, entities: readonly StoryboardEntity[], errors: FieldErrors, entityIds: Set<number>): SoundDraft[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_SOUNDS_PER_SHOT) {
    errors.sounds = `声音必须是数组，最多 ${MAX_SOUNDS_PER_SHOT} 条。`;
    return [];
  }
  const sounds: SoundDraft[] = [];
  value.forEach((item, index) => {
    const label = `第 ${index + 1} 条声音`;
    const issues: string[] = [];
    const record = isRecord(item) ? item : {};
    const kind = record.kind;
    if (typeof kind !== 'string' || !SOUND_KINDS.includes(kind as SoundKind)) {
      issues.push(`${label}的类型必须是以下之一：${SOUND_KINDS.map((key) => SOUND_KIND_LABELS[key]).join('、')}。`);
    }
    let speakerEntityId: number | null = null;
    if (kind === 'dialogue') {
      const speaker = record.speakerEntityId;
      const entity = entities.find((candidate) => candidate.id === speaker && candidate.kind === 'character');
      if (entity === undefined) {
        issues.push(`${label}必须选择说话的角色。`);
      } else {
        speakerEntityId = entity.id;
        entityIds.add(entity.id);
      }
    }
    const text = readShotText(record, 'text', label, SOUND_TEXT_MAX_LENGTH, true, issues, '台词或声音描述');
    const delivery = readShotText(record, 'delivery', label, SOUND_DELIVERY_MAX_LENGTH, false, issues, '说话方式或声音质感');
    const startOffsetSeconds = readSeconds(record.startOffsetSeconds, '开始时间', label, false, issues);
    const durationSeconds = readSeconds(record.durationSeconds, '持续时长', label, true, issues);
    if (issues.length > 0) {
      errors.sounds = issues.join('；');
      return;
    }
    sounds.push({
      kind: kind as SoundKind,
      speakerEntityId,
      text,
      delivery,
      startOffsetSeconds,
      durationSeconds,
      isEnabled: record.isEnabled !== false
    });
  });
  return sounds;
}

/**
 * 校验并规范化用户编辑保存的一个镜头（F11“镜头编辑”）；声音整体替换，出场实体必须取自可引用的实体。
 * @param rawInput 界面提交的原始内容。
 * @param entities 可引用的实体。
 * @param isFirstShot 是否为集内第 1 个镜头：没有上一镜头，首帧不能接上一镜头尾帧。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeShotEdit(rawInput: unknown, entities: readonly StoryboardEntity[], isFirstShot: boolean): ShotEdit {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const text = (key: string, label: string, max: number, required: boolean): string =>
    readText(source, { key, label, required, maxLength: max }, errors);

  const action = text('action', '画面与动作', SHOT_ACTION_MAX_LENGTH, true);
  const sceneLabel = text('sceneLabel', '场次', SHOT_LABEL_MAX_LENGTH, false);
  const shotSize = text('shotSize', '景别', SHOT_LABEL_MAX_LENGTH, false);
  const cameraAngle = text('cameraAngle', '机位与视角', SHOT_LABEL_MAX_LENGTH, false);
  const cameraMovement = text('cameraMovement', '摄影机运动', SHOT_LABEL_MAX_LENGTH, false);
  const transition = text('transition', '转场', SHOT_LABEL_MAX_LENGTH, false);
  const continuityNote = text('continuityNote', '连续性要求', SHOT_NOTE_MAX_LENGTH, false);
  const promptZh = text('promptZh', '中文提示词', SHOT_PROMPT_MAX_LENGTH, false);
  const promptEn = text('promptEn', '英文提示词', SHOT_PROMPT_MAX_LENGTH, false);
  const durationSeconds = readOptionalDecimal(
    source,
    { key: 'durationSeconds', label: '时长', min: SHOT_SECONDS_MIN, max: SHOT_SECONDS_MAX, maxDecimals: 1 },
    errors
  );
  if (durationSeconds === null && errors.durationSeconds === undefined) {
    errors.durationSeconds = '时长不能为空。';
  }

  const firstFrameMode = readOptionalChoice(source, 'firstFrameMode', '首帧来源', ['none', 'prev_tail'], errors) ?? 'none';
  if (firstFrameMode === 'prev_tail' && isFirstShot) {
    errors.firstFrameMode = '第 1 个镜头没有上一镜头，不能接上一镜头尾帧。';
  }

  const entityIds = new Set<number>();
  const rawIds = source.entityIds;
  if (rawIds !== undefined && rawIds !== null) {
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'number')) {
      errors.entityIds = '出场实体格式不正确。';
    } else {
      for (const id of rawIds as number[]) {
        if (!entities.some((entity) => entity.id === id)) {
          errors.entityIds = '出场实体必须是剧本中已有的实体。';
        } else {
          entityIds.add(id);
        }
      }
    }
  }
  const sounds = readSoundEdits(source.sounds, entities, errors, entityIds);
  assertNoFieldErrors(errors);
  return {
    sceneLabel,
    shotSize,
    cameraAngle,
    action,
    cameraMovement,
    durationSeconds: durationSeconds ?? SHOT_SECONDS_MIN,
    transition,
    continuityNote,
    firstFrameMode: firstFrameMode as FirstFrameMode,
    entityIds: [...entityIds],
    sounds,
    promptZh,
    promptEn
  };
}
