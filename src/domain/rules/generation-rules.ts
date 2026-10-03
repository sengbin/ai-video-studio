// ------------------------------------------------------------------------
// 名称：generation-rules.ts
// 说明：视频生成的规则：提交请求的读取与校验、把镜头组的总时长对齐到模型允许的取值（或按本组指定的生成时长）、检查种子、提示词改写与指定时长能否用于所选模型、按千问官方提示词公式把一组镜头编译为提示词与请求快照（含分镜编号与时间、镜头语言、台词、无台词与无背景音乐、负向清单，以及以上一组尾帧或指定图片作首帧）、工作台上传的尾帧图片的校验，以及失败原因的界面说明。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数，不依赖 VS Code、数据库和具体模型；素材只记录文件标识，内容由提交时读取；一个镜头组一次生成一个视频。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { GenerationParams, JobFailure, JobSnapshot } from '../models/generation';
import { DEFAULT_NEGATIVE_LIST } from '../models/generation-profile';
import { DurationCapability, PromptLanguage, VIDEO_AUDIO_ELEMENTS, VIDEO_AUDIO_ELEMENT_LABELS, VideoAudioElement, VideoAudioMode, VideoCapability } from '../models/model-capability';
import { ENTITY_KIND_LABELS, EntityKind } from '../models/screenplay';
import { ShotRecord, SoundRecord } from '../models/storyboard';
import { readRecord } from './field-readers';
import {
  AUDIO_ELEMENTS_ERROR_TEXT,
  NEGATIVE_LIST_ERROR_TEXT,
  PROMPT_EXTEND_ERROR_TEXT,
  SEED_ERROR_TEXT,
  isValidSeed,
  readAudioElements,
  readNegativeList
} from './generation-profile-rules';
import { describeDuration, isDurationAllowed } from './model-capability-rules';
import { sumSeconds } from './shot-group-rules';
import { VIDEO_PROMPT_FORMAT_VERSION, aspectDiffers, describeCamera, describeImageRatio, describeTransition, endSentence, normalizeNegativeItems } from './video-prompt-rules';

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
 * @param rawInput 界面提交的原始内容：workId、episodeId、groupIds、params（modelId、aspectRatio、resolution、audioMode、audioElements、seed、negativeList、promptExtend）。
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
  // 声音内容与种子为空表示不指定；填写了就必须合法，不合法时指出字段而不是静默丢弃。
  const audioElements = params.audioElements === undefined || params.audioElements === null ? null : readAudioElements(params.audioElements);
  if (audioElements === undefined) {
    throw new ValidationError({ audioElements: AUDIO_ELEMENTS_ERROR_TEXT });
  }
  const seed = params.seed === undefined || params.seed === null ? null : params.seed;
  if (seed !== null && !isValidSeed(seed)) {
    throw new ValidationError({ seed: SEED_ERROR_TEXT });
  }
  const negativeList = params.negativeList === undefined ? null : readNegativeList(params.negativeList);
  if (negativeList === undefined) {
    throw new ValidationError({ negativeList: NEGATIVE_LIST_ERROR_TEXT });
  }
  const promptExtend = params.promptExtend === undefined ? null : params.promptExtend;
  if (promptExtend !== null && typeof promptExtend !== 'boolean') {
    throw new ValidationError({ promptExtend: PROMPT_EXTEND_ERROR_TEXT });
  }
  return {
    workId,
    episodeId,
    groupIds: [...new Set(groupIds as number[])],
    params: {
      modelId: readIdentifier(params, 'modelId', '模型'),
      aspectRatio: readOptionalParam(params, 'aspectRatio', '画幅'),
      resolution: readOptionalParam(params, 'resolution', '分辨率'),
      audioMode,
      audioElements,
      seed,
      negativeList,
      promptExtend,
      // 生成时长只能按镜头组指定，提交请求不携带；镜头组的覆盖在合并参数时补上。
      durationSeconds: null
    }
  };
}

/** 单个结果视频的大小上限（字节）：既是保存结果时的下载上限，也是工作台读取视频（播放、截取尾帧）的上限；两处共用，保证保存下来的视频都能被工作台读取。 */
export const RESULT_VIDEO_MAX_BYTES = 200 * 1024 * 1024;

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

/**
 * 检查镜头组的生成参数能否用于所选模型：随机种子需要模型支持；指定的生成时长不得小于组内镜头总时长（不截断镜头），且必须在模型支持的取值内。
 * 画幅、分辨率、声音模式等由适配器按模型能力校验，这里不重复。
 * @param capability 所选模型的能力。
 * @param params 这一组合并后的生成参数。
 * @param totalSeconds 组内镜头时长之和（秒）。
 * @returns 阻断问题说明；没有问题为空数组。
 */
export function validateGroupParams(capability: VideoCapability, params: GenerationParams, totalSeconds: number): string[] {
  const issues: string[] = [];
  if (params.seed !== null && !capability.seed) {
    issues.push('所选模型不支持随机种子，请清除种子设置或换一个模型。');
  }
  if (params.promptExtend !== null && capability.promptExtend !== true) {
    issues.push('所选模型不支持提示词改写开关，请清除该设置或换一个模型。');
  }
  const requested = params.durationSeconds;
  if (requested !== null) {
    // 指定时长小于镜头总时长会让后面的镜头没有时间呈现，直接拒绝而不是静默截断。
    if (requested < totalSeconds - EPSILON) {
      issues.push(`指定的生成时长 ${requested} 秒小于这一组镜头的总时长 ${totalSeconds} 秒，镜头会被截断。请调大生成时长，或清除该设置，按镜头总时长生成。`);
    } else if (!isDurationAllowed(capability.duration, requested)) {
      issues.push(`指定的生成时长 ${requested} 秒不在模型支持的取值内（${describeDuration(capability.duration)}）。`);
    }
  }
  return issues;
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
  /** 组内第一个镜头指定图片作首帧时，已解析出的资产图片文件；没有指定或图片已不可用为 null。同样不再传参考图和音色参考，且不会与 useFirstFrame 同时出现。 */
  readonly firstFrameFileId?: number | null;
  /** 指定的首帧图片的宽高（像素）；用于和作品画幅比较，不一致时提醒。未知时不传。 */
  readonly firstFrameSize?: { readonly width: number | null; readonly height: number | null } | null;
  /** 整体画面风格（分镜脚本的风格或项目风格），写在提示词开头；没有时为 null。 */
  readonly style?: string | null;
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

/** 选择提示词语言：模型支持中文用中文，否则用英文，都没有时用画面描述（中文）。 */
function pickPrompt(shot: ShotRecord, capability: VideoCapability): { readonly text: string; readonly language: PromptLanguage } {
  if (capability.promptLanguages.includes('zh') && shot.promptZh.trim() !== '') return { text: shot.promptZh.trim(), language: 'zh' };
  if (capability.promptLanguages.includes('en') && shot.promptEn.trim() !== '') return { text: shot.promptEn.trim(), language: 'en' };
  return { text: shot.action.trim(), language: 'zh' };
}

/** 把秒数写成“分:秒”（分、秒各两位），如 75 秒为 01:15；小数秒保留 1 位。 */
export function formatTimestamp(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  const minutes = Math.floor(rounded / 60);
  const rest = Math.round((rounded - minutes * 60) * 10) / 10;
  const text = Number.isInteger(rest) ? String(rest).padStart(2, '0') : rest.toFixed(1).padStart(4, '0');
  return `${String(minutes).padStart(2, '0')}:${text}`;
}

/** 参考图说明里各类实体的称呼：如“守夜人形象参考图1”“灯塔场景参考图2”。 */
const REFERENCE_KIND_WORDS: Readonly<Record<EntityKind, string>> = {
  character: '形象',
  scene: '场景',
  prop: '道具',
  effect: '特效'
};

/**
 * 把一个镜头组编译为任务请求快照，写法依据千问AI平台官方提示词指南：
 * 提示词 = 总体描述（单镜头声明或镜头数）+ 风格 + 参考素材引用 + 分镜 N（起-止）：镜头语言与画面、台词、音效与背景音乐、转场 + 无台词、无背景音乐 + 负向清单。
 * 镜头的景别、机位与视角、摄影机运动由字段编译，所以镜头的提示词只需描述主体、场景与动作；英文提示词不使用这些字段。
 * 上一组尾帧作首帧由调用方通过 useFirstFrame 告知（尾帧图片不进快照，由任务记录）；指定图片作首帧由调用方解析出资产图片文件后通过 firstFrameFileId 告知（文件标识进快照）；组内其他镜头的首帧设置在同一个视频内自然衔接，不需要处理。
 * 组总时长超过模型单次最长时长的情况由调用方先用 maxGroupSeconds 拒绝；这里对齐后的时长不会超过模型最长时长。本组指定了生成时长（params.durationSeconds）时直接采用，是否合法由调用方先用 validateGroupParams 检查。
 * @param input 镜头组、模型能力、生成参数与出场实体的绑定。
 */
export function planGroupRequest(input: GroupPlanInput): JobSnapshot {
  const { shots, capability, params, entities } = input;
  const useFirstFrame = input.useFirstFrame === true;
  const firstFrameFileId = input.firstFrameFileId ?? null;
  // 首帧不能与参考图、音色参考同时使用，有首帧时都不传。
  const hasFirstFrame = useFirstFrame || firstFrameFileId !== null;
  const warnings: string[] = [];

  const first = shots[0];
  if (first !== undefined && first.firstFrameMode === 'prev_tail' && !useFirstFrame) {
    warnings.push('这一组设置了“上一镜头尾帧作首帧”，但没有上一组可用，本次不指定首帧。');
  } else if (first !== undefined && first.firstFrameMode === 'asset' && firstFrameFileId === null) {
    warnings.push('这一组设置了“指定图片作首帧”，但指定的图片已不可用，本次不指定首帧。');
  }

  // 有首帧时，官方建议画幅用 adaptive（按首帧宽高比自动匹配），所以不再传作品画幅；指定的图片与作品画幅差得多时提醒。
  const followsFirstFrame = hasFirstFrame && capability.firstFrameDefinesAspect === true;
  const aspectRatio = followsFirstFrame ? null : params.aspectRatio;
  const frameSize = input.firstFrameSize ?? null;
  if (followsFirstFrame && !useFirstFrame && frameSize !== null && frameSize.width !== null && frameSize.height !== null && aspectDiffers(frameSize.width, frameSize.height, params.aspectRatio)) {
    warnings.push(`指定的首帧图片比例约为 ${describeImageRatio(frameSize.width, frameSize.height)}，与作品画幅 ${params.aspectRatio} 不一致；视频会按首帧图片的比例生成，不使用作品画幅。`);
  }

  const audioMode: VideoAudioMode | null = params.audioMode ?? (capability.audioModes.includes('native') ? 'native' : capability.audioModes.includes('none') ? 'none' : null);

  // 参考图：按出场实体顺序，每个实体取形象主资产的第一张图；数量受模型上限限制。有首帧时不传参考图。
  const referenceImageFileIds: number[] = [];
  const imageNotes: string[] = [];
  const imageIndexByEntity = new Map<number, number>();
  if (hasFirstFrame) {
    if (entities.length > 0) {
      warnings.push(`这一组以${useFirstFrame ? '上一组的尾帧' : '指定的图片'}作首帧，首帧不能与参考图、音色参考同时使用，本次不传参考素材（角色、场景的形象由${useFirstFrame ? '尾帧' : '首帧图片'}延续）。`);
    }
  }
  for (const entity of hasFirstFrame ? [] : entities) {
    if (entity.visualFileId === null) {
      warnings.push(`${ENTITY_KIND_LABELS[entity.kind]}“${entity.name}”还没有绑定资产，只能按文字描述生成。`);
    } else if (referenceImageFileIds.length >= capability.referenceImagesMax) {
      warnings.push(`模型最多支持 ${capability.referenceImagesMax} 张参考图，“${entity.name}”的参考图已忽略。`);
    } else {
      referenceImageFileIds.push(entity.visualFileId);
      imageIndexByEntity.set(entity.entityId, referenceImageFileIds.length);
      imageNotes.push(`${entity.name}${REFERENCE_KIND_WORDS[entity.kind]}参考图${referenceImageFileIds.length}`);
    }
  }

  // 声音：只有原生声音模式才编译声音提示词和音色参考；用户选的声音内容（缺省为全部）之外的条目不传，选了但模型不支持的内容忽略并提醒。
  const referenceAudioFileIds: number[] = [];
  const voiceNotes: string[] = [];
  const soundsByShot = new Map<number, string[]>();
  let usedAudioElements: VideoAudioElement[] | null = null;
  let spokenLineCount = 0;
  if (audioMode === 'native') {
    const selected = params.audioElements ?? VIDEO_AUDIO_ELEMENTS;
    usedAudioElements = VIDEO_AUDIO_ELEMENTS.filter((element) => selected.includes(element) && capability.audioElements.includes(element));
    const names = new Map(entities.map((entity) => [entity.entityId, entity.name]));
    const skipped = new Set<VideoAudioElement>();
    for (const shot of shots) {
      const lines: string[] = [];
      for (const sound of shot.sounds) {
        if (!sound.isEnabled || !selected.includes(sound.kind)) continue;
        if (!capability.audioElements.includes(sound.kind)) {
          skipped.add(sound.kind);
          continue;
        }
        if (sound.kind === 'dialogue' || sound.kind === 'narration') spokenLineCount += 1;
        lines.push(describeSound(sound, speakerLabel(sound, names, imageIndexByEntity)));
      }
      soundsByShot.set(shot.id, lines);
    }
    if (skipped.size > 0) {
      warnings.push(`模型不支持以下声音内容，已忽略：${VIDEO_AUDIO_ELEMENTS.filter((element) => skipped.has(element)).map((element) => VIDEO_AUDIO_ELEMENT_LABELS[element]).join('、')}。`);
    }

    // 音色参考只服务于对白：没有选对白时，说话人不需要音色参考。
    const speakerIds = new Set(
      shots.flatMap((shot) => shot.sounds.filter((sound) => sound.isEnabled && sound.kind === 'dialogue' && selected.includes('dialogue')).map((sound) => sound.speakerEntityId))
    );
    const audioLimit = hasFirstFrame ? null : capability.audioInputMax;
    for (const entity of entities) {
      if (audioLimit === null || entity.voiceFileId === null || !speakerIds.has(entity.entityId) || referenceAudioFileIds.length >= audioLimit.count) continue;
      referenceAudioFileIds.push(entity.voiceFileId);
      voiceNotes.push(`${entity.name}音色参考音频${referenceAudioFileIds.length}`);
    }
  }

  // 时长：本组指定了生成时长就按指定值（校验由 validateGroupParams 负责，多出的时间并入最后一个镜头），否则按镜头总时长向上对齐到模型支持的取值。
  const total = sumSeconds(shots);
  const duration: FittedDuration =
    params.durationSeconds === null ? fitGroupDuration(capability.duration, total) : { seconds: params.durationSeconds, adjusted: false, exceedsMax: false };
  if (duration.adjusted) {
    warnings.push(`这一组共 ${total} 秒，不在模型支持的取值内，已调整为 ${duration.seconds} 秒。`);
  }

  // 分镜：多镜头写成“分镜 N（起-止）：…”，最后一段补足到对齐后的总时长；单镜头不加编号和时间。
  const isMulti = shots.length > 1;
  let cursor = 0;
  const segments = shots.map((shot, index) => {
    const start = cursor;
    cursor += shot.durationSeconds;
    const end = index === shots.length - 1 ? Math.max(cursor, duration.seconds) : cursor;
    const picked = pickPrompt(shot, capability);
    const isChinese = picked.language === 'zh';
    const camera = isChinese ? endSentence(describeCamera(shot)) : '';
    const sounds = (soundsByShot.get(shot.id) ?? []).map(endSentence).join('');
    // 最后一个镜头没有组内的下一镜头，它的转场属于组与组之间，不写。
    const transition = isChinese && index < shots.length - 1 ? endSentence(describeTransition(shot.transition)) : '';
    const body = `${camera}${endSentence(picked.text)}${sounds}${transition}`;
    return isMulti ? `分镜${index + 1}（${formatTimestamp(start)}-${formatTimestamp(end)}）：${body}` : body;
  });

  const sections: string[] = [];
  sections.push(isMulti ? `共 ${shots.length} 个镜头，按时间顺序依次呈现，镜头之间自然衔接。` : '生成单镜头。');
  const style = input.style?.trim() ?? '';
  if (style !== '') sections.push(endSentence(`风格：${style}`));
  const referenceNotes = [...imageNotes, ...voiceNotes];
  if (referenceNotes.length > 0) sections.push(`${referenceNotes.join('，')}。`);
  sections.push(...segments);
  // 官方：不写台词，模型会自己加台词；不写背景音乐，模型会自己发挥。用户没要的内容要明确写“无”。
  if (audioMode === 'native') {
    const absent: string[] = [];
    if (spokenLineCount === 0) absent.push('无台词');
    if (usedAudioElements !== null && !usedAudioElements.includes('music')) absent.push('无背景音乐');
    if (absent.length > 0) sections.push(`${absent.join('，')}。`);
  }
  const negativeItems = normalizeNegativeItems(params.negativeList ?? DEFAULT_NEGATIVE_LIST, sections.join('\n'));
  if (negativeItems.length > 0) sections.push(`负向清单：${negativeItems.join('，')}。`);

  return {
    storyboardRunId: input.storyboardRunId,
    shotIds: shots.map((shot) => shot.id),
    providerCode: input.providerCode,
    modelCode: input.modelCode,
    prompt: sections.join('\n'),
    promptFormat: VIDEO_PROMPT_FORMAT_VERSION,
    params: {
      aspectRatio,
      resolution: params.resolution,
      durationSeconds: duration.seconds,
      audioMode,
      audioElements: usedAudioElements,
      seed: params.seed,
      negativeList: negativeItems.length > 0 ? negativeItems.join('，') : null,
      extraParams: params.promptExtend !== null && capability.promptExtend === true ? { promptExtend: params.promptExtend } : {}
    },
    referenceImageFileIds,
    referenceAudioFileIds,
    ...(firstFrameFileId === null ? {} : { firstFrameFileId }),
    warnings
  };
}

/** 对白说话人的称呼：说话人有参考图时写成“图N的名字”（官方写法），否则只写名字；不是对白或没有说话人返回 undefined。 */
function speakerLabel(sound: SoundRecord, names: ReadonlyMap<number, string>, imageIndexByEntity: ReadonlyMap<number, number>): string | undefined {
  if (sound.speakerEntityId === null) return undefined;
  const name = names.get(sound.speakerEntityId);
  if (name === undefined) return undefined;
  const index = imageIndexByEntity.get(sound.speakerEntityId);
  return index === undefined ? name : `图${index}的${name}`;
}
