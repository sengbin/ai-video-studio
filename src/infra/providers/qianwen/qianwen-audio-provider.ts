// ------------------------------------------------------------------------
// 名称：qianwen-audio-provider.ts
// 说明：千问AI平台音频适配器：按模型能力校验请求，调用同步的音频生成与音乐生成接口，并以任务引用的形式交回结果；测试连接借用任务查询接口。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：平台音频接口是同步的：submit 内完成调用，音频地址与时长编码进 remoteJobId，query 解码后直接返回成功；音频地址 24 小时后过期。音频接口自身没有查询接口，测试连接查询“不存在的任务”：它与音频接口共用同一接口地址和访问密钥，且不会产生生成费用。
// ------------------------------------------------------------------------

import { ProviderError } from '../../../domain/errors';
import { AudioCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../../domain/models/model-provider';
import {
  AudioGenerationRequest,
  AudioJobResult,
  AudioModelProvider,
  ProviderCallContext,
  RemoteJobRef,
  RemoteJobState
} from '../../../domain/ports/provider-adapters';
import { FetchFunction, QianwenApiClient } from './qianwen-api-client';
import {
  AUDIO_PROTOCOL_PATHS,
  AUDIO_REFERENCE_MAX_BYTES,
  FIRST_VOICE_MARK,
  QIANWEN_AUDIO_MODELS,
  QianwenAudioModel
} from './qianwen-audio-catalog';
import { QIANWEN_PROVIDER } from './qianwen-catalog';
import { CONNECTION_PROBE_PATH, mapExtraParams, readObject, toDataUri, validateExtraParams, validateMediaFiles } from './qianwen-protocol';

/** 千问AI平台的音频适配器。 */
export class QianwenAudioProvider implements AudioModelProvider {
  readonly kind = 'audio';
  readonly provider: ProviderDescriptor = QIANWEN_PROVIDER;
  private readonly client: QianwenApiClient;

  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   */
  constructor(fetchFunction?: FetchFunction) {
    this.client = new QianwenApiClient(fetchFunction);
  }

  listModels(): readonly ModelDescriptor<'audio'>[] {
    return QIANWEN_AUDIO_MODELS.map((model) => model.descriptor);
  }

  getCapability(modelCode: string): AudioCapability | undefined {
    return findModel(modelCode)?.descriptor.capability;
  }

  validate(request: AudioGenerationRequest): readonly string[] {
    const model = findModel(request.modelCode);
    if (model === undefined) {
      return [`千问AI平台没有模型 ${request.modelCode}。`];
    }
    return [...validateContent(request, model), ...validateExtraParams(request.extraParams, model.extraParams)];
  }

  async submit(request: AudioGenerationRequest, context: ProviderCallContext): Promise<RemoteJobRef> {
    const issues = this.validate(request);
    if (issues.length > 0) {
      throw new ProviderError('invalid_request', issues.join('；'));
    }
    // 校验已确认模型存在。
    const model = findModel(request.modelCode) as QianwenAudioModel;
    const response = await this.client.postJson(context, AUDIO_PROTOCOL_PATHS[model.protocol], buildRequestBody(request, model));

    const audio = readObject(readObject(response.output).audio);
    if (typeof audio.url !== 'string' || audio.url === '') {
      throw new ProviderError('server', '千问AI平台没有返回音频地址。');
    }
    const result: AudioJobResult = { audioUrl: toHttpsUrl(audio.url), durationSeconds: readDuration(audio, readObject(response.usage)) };
    return { modelCode: request.modelCode, remoteJobId: JSON.stringify(result) };
  }

  checkConnection(context: ProviderCallContext): Promise<void> {
    return this.client.checkConnection(context, CONNECTION_PROBE_PATH);
  }

  async query(ref: RemoteJobRef): Promise<RemoteJobState<AudioJobResult>> {
    const audio = readObject(parseJson(ref.remoteJobId));
    if (typeof audio.audioUrl !== 'string' || audio.audioUrl === '') {
      throw new ProviderError('invalid_request', '音频任务引用已损坏，无法取得音频地址。');
    }
    const durationSeconds = typeof audio.durationSeconds === 'number' ? audio.durationSeconds : null;
    return { status: 'succeeded', result: { audioUrl: audio.audioUrl, durationSeconds }, errorCategory: null, errorCode: null, errorMessage: null };
  }
}

function findModel(modelCode: string): QianwenAudioModel | undefined {
  return QIANWEN_AUDIO_MODELS.find((model) => model.descriptor.code === modelCode);
}

/** 校验音频类型、提示词、语言、音色、时长和参考音频。 */
function validateContent(request: AudioGenerationRequest, model: QianwenAudioModel): string[] {
  const issues: string[] = [];
  const capability = model.descriptor.capability;
  if (!capability.audioKinds.includes(request.audioKind)) {
    issues.push(`该模型不能生成${request.audioKind}类型的音频，支持：${capability.audioKinds.join('、')}。`);
  }
  if (request.prompt.trim() === '') {
    issues.push('提示词不能为空。');
  }
  if (request.prompt.length > capability.promptMaxLength) {
    issues.push(`提示词不能超过 ${capability.promptMaxLength} 字（当前 ${request.prompt.length} 字）。`);
  }
  if (request.durationSeconds !== null) {
    issues.push('该模型不支持指定时长，时长由内容决定。');
  }
  if (request.language !== null && !capability.languages.includes(request.language)) {
    issues.push(`语言 ${request.language} 不在模型支持的范围内：${capability.languages.join('、')}。`);
  }
  if (request.voice !== null && !capability.voices.includes(request.voice)) {
    issues.push(`该模型不支持预置音色 ${request.voice}。`);
  }
  if (request.referenceAudio !== null) {
    if (!capability.referenceAudio) {
      issues.push('该模型不支持参考音频。');
    } else {
      issues.push(...validateMediaFiles([request.referenceAudio], 'audio/', '音频', AUDIO_REFERENCE_MAX_BYTES));
      if (!request.prompt.includes(FIRST_VOICE_MARK)) {
        issues.push(`提示词中需要用 ${FIRST_VOICE_MARK} 引用参考音频。`);
      }
    }
  }
  return issues;
}

/** 构造请求体：语音接口的提示词字段为 text_prompt，参考音频走 references；音乐接口的提示词字段为 prompt。 */
function buildRequestBody(request: AudioGenerationRequest, model: QianwenAudioModel): Record<string, unknown> {
  const input: Record<string, unknown> = model.protocol === 'speech' ? { text_prompt: request.prompt } : { prompt: request.prompt };
  if (request.referenceAudio !== null) {
    input.references = [{ audio_data: toDataUri(request.referenceAudio) }];
  }
  Object.assign(input, mapExtraParams(request.extraParams, model.extraParams));
  return { model: request.modelCode, input };
}

/** 平台可能返回 http 开头的临时地址，而下载只接受 https；对象存储同时支持 https，所以统一升级。 */
function toHttpsUrl(url: string): string {
  return url.replace(/^http:\/\//i, 'https://');
}

/** 读取音频时长：语音接口在 output.audio.duration，音乐接口在 usage.duration；都没有时为 null。 */
function readDuration(audio: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  if (typeof audio.duration === 'number') return audio.duration;
  return typeof usage.duration === 'number' ? usage.duration : null;
}

/** 解析 JSON；不合法时返回 undefined，由调用方按任务引用损坏处理。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
