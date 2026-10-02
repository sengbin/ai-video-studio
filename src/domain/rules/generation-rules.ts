// ------------------------------------------------------------------------
// 名称：generation-rules.ts
// 说明：视频生成的规则：提交请求的读取与校验、按模型能力调整镜头时长、把镜头编译为提示词与请求快照，以及失败原因的界面说明。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数，不依赖 VS Code、数据库和具体模型；素材只记录文件标识，内容由提交时读取。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { GenerationParams, JobFailure, JobSnapshot } from '../models/generation';
import { DurationCapability, VideoAudioMode, VideoCapability } from '../models/model-capability';
import { ENTITY_KIND_LABELS, EntityKind } from '../models/screenplay';
import { ShotRecord, SoundRecord } from '../models/storyboard';
import { readRecord } from './field-readers';

/** 一次提交最多包含的镜头数。 */
export const MAX_SUBMIT_SHOTS = 200;

/** 画幅、分辨率等文本参数的最大长度。 */
const PARAM_TEXT_MAX_LENGTH = 20;

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

/** 失败原因的界面说明：分类名称与处理建议。 */
export function describeJobFailure(failure: JobFailure): { readonly label: string; readonly hint: string } {
  return { label: FAILURE_LABELS[failure.category], hint: FAILURE_HINTS[failure.category] };
}

/** 读取到的提交请求：作品、集、要提交的镜头与生成参数。 */
export interface SubmitInput {
  readonly workId: number;
  readonly episodeId: number;
  readonly shotIds: readonly number[];
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
 * @param rawInput 界面提交的原始内容：workId、episodeId、shotIds、params（modelId、aspectRatio、resolution、audioMode）。
 * @throws ValidationError 内容不合法。
 */
export function readSubmitInput(rawInput: unknown): SubmitInput {
  const source = readRecord(rawInput);
  const workId = readIdentifier(source, 'workId', '作品');
  const episodeId = readIdentifier(source, 'episodeId', '集');
  const { shotIds } = source;
  if (!Array.isArray(shotIds) || shotIds.length === 0 || shotIds.length > MAX_SUBMIT_SHOTS || !shotIds.every((id) => Number.isInteger(id))) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `请选择 1 到 ${MAX_SUBMIT_SHOTS} 个镜头。` });
  }
  const params = readRecord(source.params);
  const audioMode = readOptionalParam(params, 'audioMode', '声音模式');
  if (audioMode !== null && audioMode !== 'none' && audioMode !== 'native') {
    throw new ValidationError({ audioMode: '声音模式不合法。' });
  }
  return {
    workId,
    episodeId,
    shotIds: [...new Set(shotIds as number[])],
    params: {
      modelId: readIdentifier(params, 'modelId', '模型'),
      aspectRatio: readOptionalParam(params, 'aspectRatio', '画幅'),
      resolution: readOptionalParam(params, 'resolution', '分辨率'),
      audioMode
    }
  };
}

/** 时长调整的结果：调整后的值，以及是否与原值不同。 */
export interface FittedDuration {
  readonly seconds: number;
  readonly adjusted: boolean;
}

/**
 * 把镜头时长调整到模型允许的取值：有可选值时取最接近的；有范围时四舍五入到步长后夹到范围内。
 * @param duration 模型的时长约束。
 * @param seconds 镜头时长（秒，可能有小数）。
 */
export function fitDuration(duration: DurationCapability, seconds: number): FittedDuration {
  let fitted = seconds;
  if (duration.options !== undefined && duration.options.length > 0) {
    fitted = duration.options.reduce((best, option) => (Math.abs(option - seconds) < Math.abs(best - seconds) ? option : best));
  } else {
    const { min, max, step } = duration;
    if (step !== undefined) {
      const origin = min ?? 0;
      fitted = origin + Math.round((seconds - origin) / step) * step;
    }
    if (min !== undefined) fitted = Math.max(min, fitted);
    if (max !== undefined) fitted = Math.min(max, fitted);
  }
  return { seconds: fitted, adjusted: fitted !== seconds };
}

/** 出场实体的绑定情况：形象参考图与音色参考音频的资产文件标识，没有绑定为 null。 */
export interface EntityReferences {
  readonly entityId: number;
  readonly name: string;
  readonly kind: EntityKind;
  readonly visualFileId: number | null;
  readonly voiceFileId: number | null;
}

/** 编译镜头请求所需的输入。 */
export interface ShotPlanInput {
  readonly shot: ShotRecord;
  readonly storyboardRunId: number;
  readonly providerCode: string;
  readonly modelCode: string;
  readonly capability: VideoCapability;
  readonly params: GenerationParams;
  /** 镜头出场实体及其绑定，顺序即参考图编号顺序。 */
  readonly entities: readonly EntityReferences[];
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

/**
 * 把一个镜头编译为任务请求快照：选提示词、拼上参考素材与声音说明、按模型能力调整时长与声音，并列出提醒。
 * 上一镜头尾帧与指定图片首帧本版本尚未支持：忽略首帧并给出提醒，不阻断提交。
 * @param input 镜头、模型能力、生成参数与出场实体的绑定。
 */
export function planShotRequest(input: ShotPlanInput): JobSnapshot {
  const { shot, capability, params, entities } = input;
  const warnings: string[] = [];

  if (shot.firstFrameMode === 'prev_tail') {
    warnings.push('这个镜头设置了“上一镜头尾帧作首帧”，该功能尚未开放，本次不指定首帧。');
  } else if (shot.firstFrameMode === 'asset') {
    warnings.push('这个镜头设置了“指定图片作首帧”，该功能尚未开放，本次不指定首帧。');
  }

  const audioMode: VideoAudioMode | null = params.audioMode ?? (capability.audioModes.includes('native') ? 'native' : capability.audioModes.includes('none') ? 'none' : null);
  const notes: string[] = [];

  // 参考图：按出场实体顺序，每个实体取形象主资产的第一张图；数量受模型上限限制。
  const referenceImageFileIds: number[] = [];
  for (const entity of entities) {
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
  const soundLines: string[] = [];
  if (audioMode === 'native') {
    const names = new Map(entities.map((entity) => [entity.entityId, entity.name]));
    const skipped = new Set<string>();
    for (const sound of shot.sounds) {
      if (!sound.isEnabled) continue;
      if (!capability.audioElements.includes(sound.kind)) {
        skipped.add(sound.kind);
        continue;
      }
      soundLines.push(describeSound(sound, sound.speakerEntityId === null ? undefined : names.get(sound.speakerEntityId)));
    }
    if (skipped.size > 0) warnings.push('模型不支持部分声音内容，已忽略。');

    const speakerIds = new Set(shot.sounds.filter((sound) => sound.isEnabled && sound.kind === 'dialogue').map((sound) => sound.speakerEntityId));
    const audioLimit = capability.audioInputMax;
    for (const entity of entities) {
      if (audioLimit === null || entity.voiceFileId === null || !speakerIds.has(entity.entityId) || referenceAudioFileIds.length >= audioLimit.count) continue;
      referenceAudioFileIds.push(entity.voiceFileId);
      notes.push(`音频${referenceAudioFileIds.length}是角色“${entity.name}”的音色参考。`);
    }
  }

  const duration = fitDuration(capability.duration, shot.durationSeconds);
  if (duration.adjusted) {
    warnings.push(`镜头时长 ${shot.durationSeconds} 秒不在模型支持的范围内，已调整为 ${duration.seconds} 秒。`);
  }

  const prompt = [notes.join(''), pickPrompt(shot, capability), soundLines.length === 0 ? '' : `声音：${soundLines.join('；')}`]
    .filter((part) => part !== '')
    .join('\n');
  return {
    storyboardRunId: input.storyboardRunId,
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
