// ------------------------------------------------------------------------
// 名称：qianwen-video-provider.ts
// 说明：千问AI平台万相 3.0 视频适配器：按模型能力校验请求，把与模型无关的生成请求转换为 video-synthesis 异步任务，并查询任务状态；用查询不存在的任务来测试连接。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：素材（首帧、尾帧、参考图、参考音频）以 Base64 内联传输；平台文档未提供取消接口，因此不实现 cancel；结果视频地址 24 小时后过期。
// ------------------------------------------------------------------------

import { ProviderError } from '../../../domain/errors';
import { VideoCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../../domain/models/model-provider';
import {
  MediaInput,
  ProviderCallContext,
  RemoteJobRef,
  RemoteJobState,
  VideoGenerationRequest,
  VideoJobResult,
  VideoModelProvider
} from '../../../domain/ports/provider-adapters';
import { isDurationAllowed } from '../../../domain/rules/model-capability-rules';
import { FetchFunction, QianwenApiClient } from './qianwen-api-client';
import { QIANWEN_PROVIDER, QIANWEN_VIDEO_MODELS, WAN3_AUDIO_MAX_BYTES, WAN3_IMAGE_MAX_BYTES, WAN3_SEED_MAX } from './qianwen-catalog';
import {
  ASYNC_HEADERS,
  CONNECTION_PROBE_PATH,
  ExtraParamSpec,
  QUERY_TASK_PATH,
  buildTaskState,
  mapExtraParams,
  readObject,
  readTaskId,
  toDataUri,
  validateExtraParams,
  validateMediaFiles
} from './qianwen-protocol';

/** 创建任务的接口路径。 */
const CREATE_TASK_PATH = '/services/aigc/video-generation/video-synthesis';

/** 素材类型（请求体 input.media[].type）。 */
const MEDIA_TYPE_FIRST_FRAME = 'first_frame';
const MEDIA_TYPE_LAST_FRAME = 'last_frame';
const MEDIA_TYPE_REFERENCE_IMAGE = 'reference_image';
const MEDIA_TYPE_REFERENCE_AUDIO = 'reference_audio';

/** 模型专有参数：键与请求体 parameters 中键的对应，取值都是开或关。 */
const EXTRA_PARAMETER_SPECS: Readonly<Record<string, ExtraParamSpec>> = {
  promptExtend: { apiKey: 'prompt_extend', allowed: [true, false] },
  watermark: { apiKey: 'watermark', allowed: [true, false] }
};

/** 千问AI平台的视频适配器。 */
export class QianwenVideoProvider implements VideoModelProvider {
  readonly kind = 'video';
  readonly provider: ProviderDescriptor = QIANWEN_PROVIDER;
  private readonly client: QianwenApiClient;

  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   */
  constructor(fetchFunction?: FetchFunction) {
    this.client = new QianwenApiClient(fetchFunction);
  }

  listModels(): readonly ModelDescriptor<'video'>[] {
    return QIANWEN_VIDEO_MODELS;
  }

  getCapability(modelCode: string): VideoCapability | undefined {
    return QIANWEN_VIDEO_MODELS.find((model) => model.code === modelCode)?.capability;
  }

  validate(request: VideoGenerationRequest): readonly string[] {
    const capability = this.getCapability(request.modelCode);
    if (capability === undefined) {
      return [`千问AI平台没有模型 ${request.modelCode}。`];
    }
    return [
      ...validateMediaCombination(request, capability),
      ...validateParameters(request, capability),
      ...validateExtraParams(request.extraParams, EXTRA_PARAMETER_SPECS)
    ];
  }

  async submit(request: VideoGenerationRequest, context: ProviderCallContext): Promise<RemoteJobRef> {
    const issues = this.validate(request);
    if (issues.length > 0) {
      throw new ProviderError('invalid_request', issues.join('；'));
    }
    const response = await this.client.postJson(context, CREATE_TASK_PATH, buildRequestBody(request), ASYNC_HEADERS);
    return { modelCode: request.modelCode, remoteJobId: readTaskId(response) };
  }

  checkConnection(context: ProviderCallContext): Promise<void> {
    return this.client.checkConnection(context, CONNECTION_PROBE_PATH);
  }

  async query(ref: RemoteJobRef, context: ProviderCallContext): Promise<RemoteJobState<VideoJobResult>> {
    const response = await this.client.getJson(context, `${QUERY_TASK_PATH}/${encodeURIComponent(ref.remoteJobId)}`);
    const output = readObject(response.output);
    return buildTaskState(output, () => {
      const videoUrl = output.video_url;
      if (typeof videoUrl !== 'string' || videoUrl === '') {
        throw new ProviderError('server', '任务已成功，但千问AI平台没有返回视频地址。');
      }
      const usage = readObject(response.usage);
      return { videoUrl, durationSeconds: typeof usage.output_video_duration === 'number' ? usage.output_video_duration : null };
    });
  }
}

/** 校验素材组合与素材本身：首尾帧与参考素材互斥、尾帧必须配首帧、数量、格式与大小。 */
function validateMediaCombination(request: VideoGenerationRequest, capability: VideoCapability): string[] {
  const issues: string[] = [];
  const hasFrames = request.firstFrame !== null || request.lastFrame !== null;
  const hasReferences = request.referenceImages.length > 0 || request.referenceAudios.length > 0;

  if (request.prompt.trim() === '' && !hasFrames && !hasReferences) {
    issues.push('提示词和素材至少要提供一项。');
  }
  if (request.prompt.length > capability.promptMaxLength) {
    issues.push(`提示词不能超过 ${capability.promptMaxLength} 字（当前 ${request.prompt.length} 字）。`);
  }
  if (request.lastFrame !== null && request.firstFrame === null) {
    issues.push('指定尾帧时必须同时指定首帧。');
  }
  if (hasFrames && hasReferences) {
    issues.push('首帧、尾帧不能与参考图、参考音频同时使用。');
  }
  if (request.firstFrame !== null && !capability.firstFrame) {
    issues.push('该模型不支持首帧。');
  }
  if (request.lastFrame !== null && !capability.lastFrame) {
    issues.push('该模型不支持尾帧。');
  }

  const frames = [request.firstFrame, request.lastFrame, ...request.referenceImages].filter((media): media is MediaInput => media !== null);
  issues.push(...validateMediaFiles(frames, 'image/', '图片', WAN3_IMAGE_MAX_BYTES));
  if (request.referenceImages.length > capability.referenceImagesMax) {
    issues.push(`参考图最多 ${capability.referenceImagesMax} 张（当前 ${request.referenceImages.length} 张）。`);
  }

  issues.push(...validateMediaFiles(request.referenceAudios, 'audio/', '音频', WAN3_AUDIO_MAX_BYTES));
  const audioLimit = capability.audioInputMax;
  if (request.referenceAudios.length > 0 && audioLimit === null) {
    issues.push('该模型不支持参考音频。');
  } else if (audioLimit !== null && request.referenceAudios.length > audioLimit.count) {
    issues.push(`参考音频最多 ${audioLimit.count} 段（当前 ${request.referenceAudios.length} 段）。`);
  }
  return issues;
}

/** 校验画幅、分辨率、时长、声音模式和随机种子是否在模型能力范围内。 */
function validateParameters(request: VideoGenerationRequest, capability: VideoCapability): string[] {
  const issues: string[] = [];
  if (request.aspectRatio !== null && !capability.aspectRatios.includes(request.aspectRatio)) {
    issues.push(`画幅 ${request.aspectRatio} 不在模型支持的范围内：${capability.aspectRatios.join('、')}。`);
  }
  if (request.resolution !== null && !capability.resolutions.includes(request.resolution)) {
    issues.push(`分辨率 ${request.resolution} 不在模型支持的范围内：${capability.resolutions.join('、')}。`);
  }
  if (request.durationSeconds !== null && !isDurationAllowed(capability.duration, request.durationSeconds)) {
    issues.push(`时长 ${request.durationSeconds} 秒不在模型支持的范围内。`);
  }
  if (request.audioMode !== null && !capability.audioModes.includes(request.audioMode)) {
    issues.push('该模型不支持所选的声音模式。');
  }
  if (request.seed !== null && (!capability.seed || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > WAN3_SEED_MAX)) {
    issues.push(`随机种子必须是 0 到 ${WAN3_SEED_MAX} 之间的整数，且模型需支持随机种子。`);
  }
  return issues;
}

/** 按素材组合构造 input.media；首尾帧与参考素材已由校验保证互斥。 */
function buildMedia(request: VideoGenerationRequest): Array<{ type: string; url: string }> {
  const media: Array<{ type: string; url: string }> = [];
  if (request.firstFrame !== null) media.push({ type: MEDIA_TYPE_FIRST_FRAME, url: toDataUri(request.firstFrame) });
  if (request.lastFrame !== null) media.push({ type: MEDIA_TYPE_LAST_FRAME, url: toDataUri(request.lastFrame) });
  for (const image of request.referenceImages) media.push({ type: MEDIA_TYPE_REFERENCE_IMAGE, url: toDataUri(image) });
  for (const audio of request.referenceAudios) media.push({ type: MEDIA_TYPE_REFERENCE_AUDIO, url: toDataUri(audio) });
  return media;
}

/** 构造创建任务的请求体；null 的参数不写入，由平台使用默认值。 */
function buildRequestBody(request: VideoGenerationRequest): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (request.prompt.trim() !== '') input.prompt = request.prompt;
  const media = buildMedia(request);
  if (media.length > 0) input.media = media;

  const parameters: Record<string, unknown> = {};
  if (request.resolution !== null) parameters.resolution = request.resolution;
  if (request.aspectRatio !== null) parameters.ratio = request.aspectRatio;
  // 智能时长的取值 -1 与平台一致，直接透传。
  if (request.durationSeconds !== null) parameters.duration = request.durationSeconds;
  if (request.audioMode !== null) parameters.audio = request.audioMode === 'native';
  if (request.seed !== null) parameters.seed = request.seed;
  Object.assign(parameters, mapExtraParams(request.extraParams, EXTRA_PARAMETER_SPECS));
  return { model: request.modelCode, input, parameters };
}
