// ------------------------------------------------------------------------
// 名称：screenplay-rules.ts
// 说明：剧本阶段的规则：生成参数校验、剧本包正文与抽取结果的输出校验、用户编辑集与实体时的校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：输出校验失败抛出 GeneratedOutputError，由阶段记录为失败并保留原始输出；界面提交的编辑内容校验失败抛出 ValidationError。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';
import {
  ENTITY_ATTRIBUTES,
  ENTITY_KIND_LABELS,
  EntityDraft,
  EntityEdit,
  EntityKind,
  EpisodeDraft,
  EpisodeEdit,
  ScreenplayParams,
  ScreenplayStructure,
  ScreenplayText
} from '../models/screenplay';
import { WorkKind } from '../models/work';
import { FieldErrors, assertNoFieldErrors, readInteger, readOptionalText, readRecord, readText } from './field-readers';

/** 单集最大时长（秒）的取值范围。 */
export const EPISODE_DURATION_MIN_SECONDS = 1;
export const EPISODE_DURATION_MAX_SECONDS = 3600;
/** 集数上限的最大值。 */
export const MAX_EPISODES_LIMIT = 100;

export const SCREENPLAY_EXTRA_MAX_LENGTH = 2000;
export const SCREENPLAY_TITLE_MAX_LENGTH = 100;
export const SCREENPLAY_OVERVIEW_MAX_LENGTH = 2000;
/** 剧本包正文的长度上限。 */
export const SCREENPLAY_TEXT_MAX_LENGTH = 200000;
export const EPISODE_TITLE_MAX_LENGTH = 60;
export const EPISODE_SYNOPSIS_MAX_LENGTH = 1000;
/** 单集剧本正文的长度上限；单个短视频的剧本包正文就是这一集的正文，因此同样受限。 */
export const EPISODE_TEXT_MAX_LENGTH = 20000;
/** 编辑集时目标时长的上限（秒），不受单集最大时长约束。 */
export const EPISODE_TARGET_EDIT_MAX_SECONDS = 86400;
export const ENTITY_NAME_MAX_LENGTH = 50;
export const ENTITY_ALIAS_MAX_COUNT = 10;
export const ENTITY_DESCRIPTION_MAX_LENGTH = 500;
export const ENTITY_ATTRIBUTE_MAX_LENGTH = 500;
/** 一份剧本最多抽取的实体数。 */
export const MAX_ENTITIES = 200;

const ENTITY_KINDS = Object.keys(ENTITY_KIND_LABELS) as EntityKind[];
const ALIAS_SEPARATORS = /[,，、\n]/;

/** 生成剧本时需要的作品信息，来自作品和输入快照。 */
export interface ScreenplayContext {
  readonly workKind: WorkKind;
  readonly workName: string;
  readonly params: ScreenplayParams;
}

/**
 * 校验并规范化剧本阶段的生成参数（F4 中影响生成的字段）。
 * @param rawInput 界面提交的原始内容，数字字段可以是数字或文本。
 * @param workKind 作品形态；单个短视频的集数上限固定为 1，不读取提交值。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeScreenplayParams(rawInput: unknown, workKind: WorkKind): ScreenplayParams {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const maxEpisodeDurationSeconds = readInteger(
    source,
    { key: 'maxEpisodeDurationSeconds', label: '单集最大时长', required: true, min: EPISODE_DURATION_MIN_SECONDS, max: EPISODE_DURATION_MAX_SECONDS },
    errors
  );
  const maxEpisodes =
    workKind === 'single'
      ? 1
      : readInteger(source, { key: 'maxEpisodes', label: '集数上限', required: true, min: 1, max: MAX_EPISODES_LIMIT }, errors);
  const extra = readOptionalText(source, { key: 'extra', label: '补充要求', required: false, maxLength: SCREENPLAY_EXTRA_MAX_LENGTH }, errors);
  assertNoFieldErrors(errors);
  return { maxEpisodeDurationSeconds, maxEpisodes, extra };
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

/**
 * 校验并整理模型返回的剧本包：标题、梗概、正文。
 * @param raw 模型提交的 { title, overview, fullText }。
 * @param workKind 作品形态；单个短视频只有一集，正文不得超过单集正文上限。
 * @throws GeneratedOutputError 缺字段、为空或过长。
 */
export function parseScreenplayText(raw: unknown, workKind: WorkKind): ScreenplayText {
  if (!isRecord(raw)) {
    throw new GeneratedOutputError(['剧本必须是包含 title、overview 和 fullText 的对象。']);
  }
  const title = textOf(raw, 'title');
  const overview = textOf(raw, 'overview');
  const fullText = textOf(raw, 'fullText');

  const issues: string[] = [];
  if (title.length === 0 || title.length > SCREENPLAY_TITLE_MAX_LENGTH) {
    issues.push(`title 必须是 1 到 ${SCREENPLAY_TITLE_MAX_LENGTH} 字的文本。`);
  }
  if (overview.length === 0 || overview.length > SCREENPLAY_OVERVIEW_MAX_LENGTH) {
    issues.push(`overview 必须是 1 到 ${SCREENPLAY_OVERVIEW_MAX_LENGTH} 字的文本。`);
  }
  if (fullText.length === 0) {
    issues.push('fullText 不能为空。');
  } else if (fullText.length > SCREENPLAY_TEXT_MAX_LENGTH) {
    issues.push(`fullText 有 ${fullText.length} 字，超过上限 ${SCREENPLAY_TEXT_MAX_LENGTH} 字。`);
  } else if (workKind === 'single' && fullText.length > EPISODE_TEXT_MAX_LENGTH) {
    issues.push(`单个短视频的剧本正文有 ${fullText.length} 字，超过 ${EPISODE_TEXT_MAX_LENGTH} 字，请精简。`);
  }
  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return { title, overview, fullText };
}

/** 读取并校验一集；序号由顺序决定。 */
function parseEpisode(item: unknown, index: number, context: ScreenplayContext, fullText: string, issues: string[]): EpisodeDraft {
  const seq = index + 1;
  const record = isRecord(item) ? item : {};
  const single = context.workKind === 'single';

  const title = single ? context.workName : textOf(record, 'title');
  if (title.length === 0 || title.length > EPISODE_TITLE_MAX_LENGTH) {
    issues.push(`第 ${seq} 集标题必须是 1 到 ${EPISODE_TITLE_MAX_LENGTH} 字的文本。`);
  }
  const synopsis = textOf(record, 'synopsis');
  if (synopsis.length === 0 || synopsis.length > EPISODE_SYNOPSIS_MAX_LENGTH) {
    issues.push(`第 ${seq} 集梗概必须是 1 到 ${EPISODE_SYNOPSIS_MAX_LENGTH} 字的文本。`);
  }
  const screenplayText = single ? fullText : textOf(record, 'screenplayText');
  if (screenplayText.length === 0 || screenplayText.length > EPISODE_TEXT_MAX_LENGTH) {
    issues.push(`第 ${seq} 集 screenplayText 必须是 1 到 ${EPISODE_TEXT_MAX_LENGTH} 字的文本。`);
  }

  const rawDuration = record.targetDurationSeconds;
  let targetDurationSeconds: number | null = null;
  if (rawDuration !== undefined && rawDuration !== null) {
    const max = context.params.maxEpisodeDurationSeconds;
    if (typeof rawDuration !== 'number' || !Number.isInteger(rawDuration) || rawDuration < 1 || rawDuration > max) {
      issues.push(`第 ${seq} 集 targetDurationSeconds 必须是 1 到 ${max} 之间的整数。`);
    } else {
      targetDurationSeconds = rawDuration;
    }
  }
  return { seq, title, synopsis, screenplayText, targetDurationSeconds };
}

/** 读取别名：去除空白、与名称相同和重复的项。 */
function readAliases(value: unknown, name: string, label: string, issues: string[]): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((alias) => typeof alias !== 'string')) {
    issues.push(`${label}的 aliases 必须是文本数组。`);
    return [];
  }
  const aliases = [...new Set((value as string[]).map((alias) => alias.trim()).filter((alias) => alias.length > 0 && alias !== name))];
  if (aliases.length > ENTITY_ALIAS_MAX_COUNT || aliases.some((alias) => alias.length > ENTITY_NAME_MAX_LENGTH)) {
    issues.push(`${label}的别名最多 ${ENTITY_ALIAS_MAX_COUNT} 个，每个不超过 ${ENTITY_NAME_MAX_LENGTH} 字。`);
  }
  return aliases;
}

/** 读取设定字段：只取该类型允许的键，值必须是非空文本；空值忽略。 */
function readAttributes(value: unknown, kind: EntityKind, label: string, issues: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (value === undefined || value === null) {
    return attributes;
  }
  if (!isRecord(value)) {
    issues.push(`${label}的 attributes 必须是对象。`);
    return attributes;
  }
  for (const { key } of ENTITY_ATTRIBUTES[kind]) {
    const entry = value[key];
    if (entry === undefined || entry === null || entry === '') {
      continue;
    }
    if (typeof entry !== 'string' || entry.trim().length > ENTITY_ATTRIBUTE_MAX_LENGTH) {
      issues.push(`${label}的 ${key} 必须是不超过 ${ENTITY_ATTRIBUTE_MAX_LENGTH} 字的文本。`);
    } else if (entry.trim().length > 0) {
      attributes[key] = entry.trim();
    }
  }
  return attributes;
}

/** 读取并校验一个实体；names 记录已出现的（类型，名称）用于查重。 */
function parseEntity(item: unknown, index: number, names: Set<string>, issues: string[]): EntityDraft | undefined {
  const record = isRecord(item) ? item : {};
  const label = `第 ${index + 1} 个实体`;
  const kind = record.kind;
  if (typeof kind !== 'string' || !ENTITY_KINDS.includes(kind as EntityKind)) {
    issues.push(`${label}的 kind 必须是 ${ENTITY_KINDS.join('、')} 之一。`);
    return undefined;
  }
  const name = textOf(record, 'name');
  if (name.length === 0 || name.length > ENTITY_NAME_MAX_LENGTH) {
    issues.push(`${label}的 name 必须是 1 到 ${ENTITY_NAME_MAX_LENGTH} 字的文本。`);
    return undefined;
  }
  const key = `${kind}\u0000${name}`;
  if (names.has(key)) {
    issues.push(`${ENTITY_KIND_LABELS[kind as EntityKind]}“${name}”重复出现，同类型的实体名称不能重复。`);
    return undefined;
  }
  names.add(key);

  const description = textOf(record, 'description');
  if (description.length > ENTITY_DESCRIPTION_MAX_LENGTH) {
    issues.push(`${label}的 description 不能超过 ${ENTITY_DESCRIPTION_MAX_LENGTH} 字。`);
  }
  return {
    kind: kind as EntityKind,
    name,
    aliases: readAliases(record.aliases, name, label, issues),
    description,
    attributes: readAttributes(record.attributes, kind as EntityKind, label, issues),
    isActive: true
  };
}

/**
 * 校验并整理模型从剧本正文抽取的集和实体。
 * @param raw 模型提交的 { episodes, entities }。
 * @param context 作品形态、作品名称与生成参数；单个短视频只能有 1 集，标题取作品名称、正文取剧本包正文。
 * @param fullText 剧本包正文。
 * @throws GeneratedOutputError 格式不对、集数不符或实体重名。
 */
export function parseStructure(raw: unknown, context: ScreenplayContext, fullText: string): ScreenplayStructure {
  if (!isRecord(raw) || !Array.isArray(raw.episodes) || !Array.isArray(raw.entities)) {
    throw new GeneratedOutputError(['结果必须是包含 episodes 数组和 entities 数组的对象。']);
  }

  const issues: string[] = [];
  const { maxEpisodes } = context.params;
  if (raw.episodes.length === 0) {
    issues.push('episodes 至少需要 1 集。');
  } else if (context.workKind === 'single' && raw.episodes.length !== 1) {
    issues.push(`单个短视频只能有 1 集，现在有 ${raw.episodes.length} 集。`);
  } else if (raw.episodes.length > maxEpisodes) {
    issues.push(`episodes 有 ${raw.episodes.length} 集，超过上限 ${maxEpisodes} 集，请合并或精简。`);
  }
  if (raw.entities.length > MAX_ENTITIES) {
    issues.push(`entities 有 ${raw.entities.length} 个，超过上限 ${MAX_ENTITIES} 个，请合并次要实体。`);
  }

  const episodes = raw.episodes.map((item, index) => parseEpisode(item, index, context, fullText, issues));
  const names = new Set<string>();
  const entities = raw.entities
    .map((item, index) => parseEntity(item, index, names, issues))
    .filter((entity): entity is EntityDraft => entity !== undefined);

  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return { episodes, entities };
}

/**
 * 校验并规范化用户编辑保存的剧本包正文。
 * @param rawInput 界面提交的原始内容 { fullText }。
 * @throws ValidationError 为空或过长。
 */
export function normalizeScreenplayTextEdit(rawInput: unknown): string {
  const errors: FieldErrors = {};
  const fullText = readText(
    readRecord(rawInput),
    { key: 'fullText', label: '剧本包正文', required: true, maxLength: SCREENPLAY_TEXT_MAX_LENGTH },
    errors
  );
  assertNoFieldErrors(errors);
  return fullText;
}

/**
 * 校验并规范化用户编辑保存的一集（F12“集编辑”）。
 * @param rawInput 界面提交的原始内容。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeEpisodeEdit(rawInput: unknown): EpisodeEdit {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const title = readText(source, { key: 'title', label: '集标题', required: true, maxLength: EPISODE_TITLE_MAX_LENGTH }, errors);
  const synopsis = readText(source, { key: 'synopsis', label: '本集梗概', required: false, maxLength: EPISODE_SYNOPSIS_MAX_LENGTH }, errors);
  const screenplayText = readText(
    source,
    { key: 'screenplayText', label: '本集剧本正文', required: false, maxLength: EPISODE_TEXT_MAX_LENGTH },
    errors
  );
  const rawDuration = source.targetDurationSeconds;
  const hasDuration = !(rawDuration === undefined || rawDuration === null || (typeof rawDuration === 'string' && rawDuration.trim() === ''));
  const duration = hasDuration
    ? readInteger(
        source,
        { key: 'targetDurationSeconds', label: '本集目标时长', required: true, min: 1, max: EPISODE_TARGET_EDIT_MAX_SECONDS },
        errors
      )
    : null;
  assertNoFieldErrors(errors);
  return { title, synopsis, screenplayText, targetDurationSeconds: duration };
}

/**
 * 校验并规范化用户编辑保存的一个实体（F12“实体编辑”）；类型不能修改，设定字段按类型取舍。
 * @param rawInput 界面提交的原始内容，aliases 为逗号、顿号或换行分隔的文本。
 * @param kind 实体类型。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeEntityEdit(rawInput: unknown, kind: EntityKind): EntityEdit {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const name = readText(source, { key: 'name', label: '实体名称', required: true, maxLength: ENTITY_NAME_MAX_LENGTH }, errors);
  const description = readText(
    source,
    { key: 'description', label: '设定摘要', required: false, maxLength: ENTITY_DESCRIPTION_MAX_LENGTH },
    errors
  );

  const rawAliases = source.aliases;
  if (rawAliases !== undefined && rawAliases !== null && typeof rawAliases !== 'string') {
    errors.aliases = '别名必须是文本。';
  }
  const aliases =
    typeof rawAliases === 'string'
      ? [...new Set(rawAliases.split(ALIAS_SEPARATORS).map((alias) => alias.trim()).filter((alias) => alias.length > 0 && alias !== name))]
      : [];
  if (aliases.length > ENTITY_ALIAS_MAX_COUNT || aliases.some((alias) => alias.length > ENTITY_NAME_MAX_LENGTH)) {
    errors.aliases = `别名最多 ${ENTITY_ALIAS_MAX_COUNT} 个，每个不超过 ${ENTITY_NAME_MAX_LENGTH} 字。`;
  }

  const rawAttributes = source.attributes === undefined || source.attributes === null ? {} : source.attributes;
  const attributeSource = readRecord(rawAttributes);
  const attributes: Record<string, string> = {};
  for (const { key, label } of ENTITY_ATTRIBUTES[kind]) {
    const text = readText(attributeSource, { key, label, required: false, maxLength: ENTITY_ATTRIBUTE_MAX_LENGTH }, errors);
    if (text.length > 0) {
      attributes[key] = text;
    }
  }

  const isActive = source.isActive === undefined ? true : source.isActive === true;
  assertNoFieldErrors(errors);
  return { name, aliases, description, attributes, isActive };
}
