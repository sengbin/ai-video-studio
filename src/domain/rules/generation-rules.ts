// ------------------------------------------------------------------------
// 名称：generation-rules.ts
// 说明：视频生成的规则：提交请求的读取与校验、把镜头组的总时长对齐到模型允许的取值、把一组镜头编译为带时间段的提示词与请求快照（含以上一组尾帧作首帧）、工作台上传的尾帧图片的校验，以及失败原因的界面说明。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数，不依赖 VS Code、数据库和具体模型；素材只记录文件标识，内容由提交时读取；一个镜头组一次生成一个视频。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { GenerationParams, JobFailure, JobSnapshot } from '../models/generation';
import { DurationCapability, VideoAudioMode, VideoCapability } from '../models/model-capability';
import { ENTITY_KIND_LABELS, EntityKind } from '../models/screenplay';
import { ShotRecord, SoundRecord } from '../models/storyboard';
import { readRecord } from './field-readers';
import { sumSeconds } from './shot-group-rules';

/** 一次提交最多包含的镜头组数。 */
export const MAX_SUBMIT_GROUPS = 100;

/** 画幅、分辨率等文本参数的最大长度。 */
const PARAM_TEXT_MAX_LENGTH = 20;

/** 比较时长的误差。 */
const EPSILON = 1e-6;

/** 失败分类的界面名称。 */
const FAILURE_LABELS: Readonly<Record<JobFailure['category'], string>> = {
  auth: '密钥或账号问题',
  rate_limited: '请求被限流',
  invalid_request: '参数不符合要求',
  content_rejected: '内容审核未通过',
  server: '服务端错误',
  network: '网络错误'
};

/** 失败分类对应的处理建议，告诉用户下一步怎么做。 */
const FAILURE_HINTS: Readonly<Record<JobFailure['category'], string>> = {
  auth: '请到“设置 > 模型”检查访问密钥是否正确、账号是否欠费，处理后重新生成。',
  rate_limited: '平台限制了请求频率，请稍等片刻后重新生成。',
  invalid_request: '请求的参数不符合模型要求，请检查画幅、分辨率、时长和素材后重新生成。',
  content_rejected: '平台认为镜头描述、声音台词或参考素材包含不允许的内容。请点“编辑镜头”修改画面描述或台词，确认分镜脚本后重新生成。',
  server: '服务商暂时出错，通常稍后重新生成即可；多次失败时请查看原因说明。',
  network: '无法连接服务商，请检查网络后重新生成。'
};

/** 前序镜头组的任务失败、被取消或已不存在，等待它的任务因此失败时的错误码。 */
export const PREVIOUS_GROUP_UNAVAILABLE_CODE = 'PreviousGroupUnavailable';
/** 无法从前序镜头组的视频截取尾帧时的错误码。 */
export const TAIL_FRAME_UNAVAILABLE_CODE = 'TailFrameUnavailable';

/** 本扩展自己产生的失败（不来自服务商）的界面说明，按错误码查找。 */
const SPECIAL_FAILURES: ReadonlyMap<string, { readonly label: string; readonly hint: string }> = new Map([
  [
    PREVIOUS_GROUP_UNAVAILABLE_CODE,
    { label: '上一组没有可用的结果', hint: '这一组要用上一组的尾帧作首帧。请先重新生成上一组，成功后再生成这一组。' }
  ],
  [
    TAIL_FRAME_UNAVAILABLE_CODE,
    {
      label: '无法截取上一组的尾帧',
      hint: '工作台没能从上一组的视频里截取尾帧（视频格式可能不被 VS Code 支持）。可以点“编辑镜头”把首帧来源改为“无”，或重新生成上一组后再试。'
    }
  ]
]);

/** 失败原因的界面说明：分类名称与处理建议。 */
export function describeJobFailure(failure: JobFailure): { readonly label: string; readonly hint: string } {
  const special = failure.code === null ? undefined : SPECIAL_FAILURES.get(failure.code);
  return special ?? { label: FAILURE_LABELS[failure.category], hint: FAILURE_HINTS[failure.category] };
}

/** 读取到的提交请求：作品、集、要提交的镜头组与生成参数。 */
export interface SubmitInput {
  readonly workId: number;
  readonly episodeId: number;
  readonly groupIds: readonly number[];
  readonly params: GenerationParams;
}

/** 读取请求中的整数标识；缺失或不是整数时抛出校验错误。 */
function readIdentifier(source: Record<string, unknown>, key: string, label: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `${label}标识无效。` });
  }
  return value;
}

/** 读取可选的短文本参数；空值为 null。 */
function readOptionalParam(source: Record<string, unknown>, key: string, label: string): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || value.length > PARAM_TEXT_MAX_LENGTH) {
    throw new ValidationError({ [key]: `${label}不合法。` });
  }
  return value;
}

/**
 * 读取并校验提交请求。
 * @param rawInput 界面提交的原始内容：workId、episodeId、groupIds、params（modelId、aspectRatio、resolution、audioMode）。
 * @throws ValidationError 内容不合法。
 */
export function readSubmitInput(rawInput: unknown): SubmitInput {
  const source = readRecord(rawInput);
  const workId = readIdentifier(source, 'workId', '作品');
  const episodeId = readIdentifier(source, 'episodeId', '集');
  const { groupIds } = source;
  if (!Array.isArray(groupIds) || groupIds.length === 0 || groupIds.length > MAX_SUBMIT_GROUPS || !groupIds.every((id) => Number.isInteger(id))) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `请选择 1 到 ${MAX_SUBMIT_GROUPS} 个镜头组。` });
  }
  const params = readRecord(source.params);
  const audioMode = readOptionalParam(params, 'audioMode', '声音模式');
  if (audioMode !== null && audioMode !== 'none' && audioMode !== 'native') {
    throw new ValidationError({ audioMode: '声音模式不合法。' });
  }
  return {
    workId,
    episodeId,
    groupIds: [...new Set(groupIds as number[])],
    params: {
      modelId: readIdentifier(params, 'modelId', '模型'),
      aspectRatio: readOptionalParam(params, 'aspectRatio', '画幅'),
      resolution: readOptionalParam(params, 'resolution', '分辨率'),
      audioMode
    }
  };
}

/** 尾帧图片的大小上限（字节）与可接受的图片类型。 */
export const TAIL_FRAME_MAX_BYTES = 10 * 1024 * 1024;
const TAIL_FRAME_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
/** 尾帧图片单边像素的上限。 */
const TAIL_FRAME_MAX_SIDE = 16384;
/** 尾帧失败说明的最大长度。 */
const TAIL_FRAME_REASON_MAX_LENGTH = 200;

/** 工作台截取到的尾帧图片：Base64 内容尚未解码。 */
export interface TailFrameInput {
  readonly resultId: number;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly dataBase64: string;
}

/**
 * 读取并校验工作台提交的尾帧图片。
 * @param rawInput { resultId, mimeType, width, height, data（Base64） }。
 * @throws ValidationError 内容不合法。
 */
export function readTailFrameInput(rawInput: unknown): TailFrameInput {
  const source = readRecord(rawInput);
  const mimeType = source.mimeType;
  if (typeof mimeType !== 'string' || !TAIL_FRAME_MIME_TYPES.includes(mimeType)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '尾帧图片类型必须是 JPEG、PNG 或 WebP。' });
  }
  const side = (key: 'width' | 'height'): number => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TAIL_FRAME_MAX_SIDE) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '尾帧图片的宽高不合法。' });
    }
    return value;
  };
  const { data } = source;
  if (typeof data !== 'string' || data === '' || data.length > Math.ceil((TAIL_FRAME_MAX_BYTES * 4) / 3) + 4) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `尾帧图片不能为空，且不超过 ${TAIL_FRAME_MAX_BYTES / (1024 * 1024)} MB。` });
  }
  return { resultId: readIdentifier(source, 'resultId', '结果'), mimeType, width: side('width'), height: side('height'), dataBase64: data };
}

/** 读取截取尾帧失败的上报：结果标识与失败原因（截断到合理长度，缺省为空串）。 */
export function readTailFrameFailure(rawInput: unknown): { readonly resultId: number; readonly reason: string } {
  const source = readRecord(rawInput);
  const reason = typeof source.reason === 'string' ? source.reason.trim().slice(0, TAIL_FRAME_REASON_MAX_LENGTH) : '';
  return { resultId: readIdentifier(source, 'resultId', '结果'), reason };
}

/** 时长对齐的结果：对齐后的值、是否与原值不同、是否超过模型单次可生成的最长时长。 */
export interface FittedDuration {
  readonly seconds: number;
  readonly adjusted: boolean;
  readonly exceedsMax: boolean;
}

/**
 * 把镜头组的总时长对齐到模型允许的取值。只向上取整（不截断镜头），超过模型最长时长时标记 exceedsMax 并返回最长值。
 * @param duration 模型的时长约束。
 * @param seconds 镜头组总时长（秒，可能有小数）。
 */
export function fitGroupDuration(duration: DurationCapability, seconds: number): FittedDuration {
  let fitted = seconds;
  let exceedsMax = false;
  if (duration.options !== undefined && duration.options.length > 0) {
    const options = [...duration.options].sort((left, right) => left - right);
    const match = options.find((option) => option >= seconds - EPSILON);
    exceedsMax = match === undefined;
    fitted = match ?? options[options.length - 1];
  } else {
    const { min, max, step } = duration;
    if (step !== undefined) {
      const origin = min ?? 0;
      fitted = origin + Math.ceil((seconds - origin) / step - EPSILON) * step;
    }
    if (min !== undefined) fitted = Math.max(min, fitted);
    if (max !== undefined && fitted > max + EPSILON) {
      exceedsMax = true;
      fitted = max;
    }
  }
  return { seconds: fitted, adjusted: Math.abs(fitted - seconds) > EPSILON, exceedsMax };
}

/** 模型单次可生成的最长时长（秒）；没有上限信息时为 null。 */
export function maxGroupSeconds(duration: DurationCapability): number | null {
  if (duration.options !== undefined && duration.options.length > 0) return Math.max(...duration.options);
  return duration.max ?? null;
}

/** 出场实体的绑定情况：形象参考图与音色参考音频的资产文件标识，没有绑定为 null。 */
export interface EntityReferences {
  readonly entityId: number;
  readonly name: string;
  readonly kind: EntityKind;
  readonly visualFileId: number | null;
  readonly voiceFileId: number | null;
}

/** 编译镜头组请求所需的输入。 */
export interface GroupPlanInput {
  /** 组内镜头，按序号排列。 */
  readonly shots: readonly ShotRecord[];
  readonly storyboardRunId: number;
  readonly providerCode: string;
  readonly modelCode: string;
  readonly capability: VideoCapability;
  readonly params: GenerationParams;
  /** 组内出场的实体（去重）及其绑定，顺序即参考图编号顺序。 */
  readonly entities: readonly EntityReferences[];
  /** 本次是否以上一组的尾帧作首帧；为 true 时不再传参考图和音色参考（首帧不能与参考素材同时使用）。 */
  readonly useFirstFrame?: boolean;
}

/** 声音条目编译成一句提示词。 */
function describeSound(sound: SoundRecord, speakerName: string | undefined): string {
  const delivery = sound.delivery.trim();
  const nuance = delivery === '' ? '' : `（${delivery}）`;
  switch (sound.kind) {
    case 'dialogue':
      return `${speakerName ?? '角色'}${nuance}说：“${sound.text}”`;
    case 'narration':
      return `旁白${nuance}：“${sound.text}”`;
    case 'sfx':
      return `音效：${sound.text}${nuance}`;
    case 'music':
      return `背景音乐：${sound.text}${nuance}`;
  }
}

/** 选择提示词语言：模型支持中文用中文，否则用英文，都没有时用画面描述。 */
function pickPrompt(shot: ShotRecord, capability: VideoCapability): string {
  if (capability.promptLanguages.includes('zh') && shot.promptZh.trim() !== '') return shot.promptZh.trim();
  if (capability.promptLanguages.includes('en') && shot.promptEn.trim() !== '') return shot.promptEn.trim();
  return shot.action.trim();
}

/** 把秒数写成“分:秒”，如 75 秒为 1:15；小数秒保留 1 位。 */
export function formatTimestamp(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  const minutes = Math.floor(rounded / 60);
  const rest = Math.round((rounded - minutes * 60) * 10) / 10;
  const text = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${minutes}:${text}`;
}

/**
 * 把一个镜头组编译为任务请求快照：多镜头用“(开始 - 结束)”时间段依次描述，拼上参考素材与声音说明，按模型能力对齐时长与声音，并列出提醒。
 * 上一组尾帧作首帧由调用方通过 useFirstFrame 告知（尾帧图片不进快照，由任务记录）；指定图片首帧本版本尚未支持：组内第一个镜头设置了它时忽略并提醒；组内其他镜头的首帧设置在同一个视频内自然衔接，不需要处理。
 * 组总时长超过模型单次最长时长的情况由调用方先用 maxGroupSeconds 拒绝；这里对齐后的时长不会超过模型最长时长。
 * @param input 镜头组、模型能力、生成参数与出场实体的绑定。
 */
export function planGroupRequest(input: GroupPlanInput): JobSnapshot {
  const { shots, capability, params, entities } = input;
  const useFirstFrame = input.useFirstFrame === true;
  const warnings: string[] = [];

  const first = shots[0];
  if (first !== undefined && first.firstFrameMode === 'prev_tail' && !useFirstFrame) {
    warnings.push('这一组设置了“上一镜头尾帧作首帧”，但没有上一组可用，本次不指定首帧。');
  } else if (first !== undefined && first.firstFrameMode === 'asset') {
    warnings.push('这一组设置了“指定图片作首帧”，该功能尚未开放，本次不指定首帧。');
  }

  const audioMode: VideoAudioMode | null = params.audioMode ?? (capability.audioModes.includes('native') ? 'native' : capability.audioModes.includes('none') ? 'none' : null);
  const notes: string[] = [];

  // 参考图：按出场实体顺序，每个实体取形象主资产的第一张图；数量受模型上限限制。用上一组尾帧作首帧时不传参考图。
  const referenceImageFileIds: number[] = [];
  if (useFirstFrame) {
    if (entities.length > 0) warnings.push('这一组以上一组的尾帧作首帧，首帧不能与参考图、音色参考同时使用，本次不传参考素材（角色、场景的形象由尾帧延续）。');
  }
  for (const entity of useFirstFrame ? [] : entities) {
    if (entity.visualFileId === null) {
      warnings.push(`${ENTITY_KIND_LABELS[entity.kind]}“${entity.name}”还没有绑定资产，只能按文字描述生成。`);
    } else if (referenceImageFileIds.length >= capability.referenceImagesMax) {
      warnings.push(`模型最多支持 ${capability.referenceImagesMax} 张参考图，“${entity.name}”的参考图已忽略。`);
    } else {
      referenceImageFileIds.push(entity.visualFileId);
      notes.push(`图${referenceImageFileIds.length}是${ENTITY_KIND_LABELS[entity.kind]}“${entity.name}”的形象参考。`);
    }
  }

  // 声音：只有原生声音模式才编译声音提示词和音色参考；模型不支持的声音内容忽略并提醒。
  const referenceAudioFileIds: number[] = [];
  const soundsByShot = new Map<number, string[]>();
  if (audioMode === 'native') {
    const names = new Map(entities.map((entity) => [entity.entityId, entity.name]));
    const skipped = new Set<string>();
    for (const shot of shots) {
      const lines: string[] = [];
      for (const sound of shot.sounds) {
        if (!sound.isEnabled) continue;
        if (!capability.audioElements.includes(sound.kind)) {
          skipped.add(sound.kind);
          continue;
        }
        lines.push(describeSound(sound, sound.speakerEntityId === null ? undefined : names.get(sound.speakerEntityId)));
      }
      soundsByShot.set(shot.id, lines);
    }
    if (skipped.size > 0) warnings.push('模型不支持部分声音内容，已忽略。');

    const speakerIds = new Set(shots.flatMap((shot) => shot.sounds.filter((sound) => sound.isEnabled && sound.kind === 'dialogue').map((sound) => sound.speakerEntityId)));
    const audioLimit = useFirstFrame ? null : capability.audioInputMax;
    for (const entity of entities) {
      if (audioLimit === null || entity.voiceFileId === null || !speakerIds.has(entity.entityId) || referenceAudioFileIds.length >= audioLimit.count) continue;
      referenceAudioFileIds.push(entity.voiceFileId);
      notes.push(`音频${referenceAudioFileIds.length}是角色“${entity.name}”的音色参考。`);
    }
  }

  const total = sumSeconds(shots);
  const duration = fitGroupDuration(capability.duration, total);
  if (duration.adjusted) {
    warnings.push(`这一组共 ${total} 秒，不在模型支持的取值内，已调整为 ${duration.seconds} 秒。`);
  }

  // 镜头段：多镜头加时间段标注，最后一段补足到对齐后的总时长；单镜头不加。
  const isMulti = shots.length > 1;
  let cursor = 0;
  const segments = shots.map((shot, index) => {
    const start = cursor;
    cursor += shot.durationSeconds;
    const end = index === shots.length - 1 ? Math.max(cursor, duration.seconds) : cursor;
    const sound = soundsByShot.get(shot.id) ?? [];
    const body = [pickPrompt(shot, capability), sound.length === 0 ? '' : `声音：${sound.join('；')}`].filter((part) => part !== '').join(' ');
    return isMulti ? `(${formatTimestamp(start)} - ${formatTimestamp(end)}) ${body}` : body;
  });

  const prompt = [notes.join(''), isMulti ? `多镜头分镜，共 ${shots.length} 个镜头，按时间段依次呈现，镜头之间自然切换：` : '', segments.join('\n')]
    .filter((part) => part !== '')
    .join('\n');
  return {
    storyboardRunId: input.storyboardRunId,
    shotIds: shots.map((shot) => shot.id),
    providerCode: input.providerCode,
    modelCode: input.modelCode,
    prompt,
    params: {
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      durationSeconds: duration.seconds,
      audioMode,
      seed: null,
      extraParams: {}
    },
    referenceImageFileIds,
    referenceAudioFileIds,
    warnings
  };
}
