// ------------------------------------------------------------------------
// 名称：fake-model-providers.ts
// 说明：测试用的假模型适配器：一个服务商同时提供文本、视频、图像与音频适配器，请求与调用记录可检查，远端任务状态可脚本化。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除；后续生成队列的测试也复用它。
// ------------------------------------------------------------------------

import { VideoCapability, ImageCapability, AudioCapability, TextCapability } from '../../models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../models/model-provider';
import {
  AudioGenerationRequest,
  AudioJobResult,
  AudioModelProvider,
  ImageGenerationRequest,
  ImageJobResult,
  ImageModelProvider,
  ProviderCallContext,
  RemoteJobRef,
  RemoteJobState,
  TextModelProvider,
  VideoGenerationRequest,
  VideoJobResult,
  VideoModelProvider
} from '../provider-adapters';
import { TextGenerationRequest } from '../text-generation-port';

/** 假服务商的代码。 */
export const FAKE_PROVIDER_CODE = 'fake';

/** 假服务商：一个 https 地址设置项和一个下拉设置项。 */
export const FAKE_PROVIDER: ProviderDescriptor = {
  code: FAKE_PROVIDER_CODE,
  displayName: '假服务商',
  settingFields: [
    { key: 'endpoint', label: '接口地址', control: 'text', defaultValue: 'https://fake.example.com/api', format: 'https-url' },
    {
      key: 'region',
      label: '地域',
      control: 'select',
      options: [
        { value: 'cn', label: '国内' },
        { value: 'intl', label: '国际' }
      ],
      defaultValue: 'cn'
    }
  ]
};

/** 假视频模型的能力。 */
export const FAKE_VIDEO_CAPABILITY: VideoCapability = {
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720P', '1080P'],
  duration: { min: 2, max: 10, step: 1 },
  fps: [24],
  audioModes: ['none', 'native'],
  audioElements: ['dialogue', 'sfx'],
  voiceReference: false,
  audioInputMax: null,
  firstFrame: true,
  lastFrame: false,
  referenceImagesMax: 3,
  seed: true,
  promptLanguages: ['zh'],
  promptMaxLength: 1000
};

/** 假图像模型的能力。 */
export const FAKE_IMAGE_CAPABILITY: ImageCapability = {
  aspectRatios: ['1:1'],
  resolutions: ['1024*1024'],
  imagesPerRequestMax: 4,
  referenceImagesMax: 0,
  seed: false,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: 500
};

/** 资产生成测试用的图像模型能力：支持两种画幅、两档分辨率和最多 2 张参考图。 */
export const FAKE_ASSET_IMAGE_CAPABILITY: ImageCapability = {
  aspectRatios: ['1:1', '16:9'],
  resolutions: ['1K', '2K'],
  imagesPerRequestMax: 4,
  referenceImagesMax: 2,
  seed: false,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: 500
};

/** 假音频模型的能力：支持音色参考和音效，不支持配乐。 */
export const FAKE_AUDIO_CAPABILITY: AudioCapability = {
  audioKinds: ['voice', 'sfx'],
  duration: {},
  languages: ['zh', 'en'],
  voices: ['小红'],
  referenceAudio: false,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: 300
};

/** 假服务商的调用凭据与设置，供测试直接使用。 */
export const FAKE_CALL_CONTEXT: ProviderCallContext = {
  apiKey: 'sk-fake',
  settings: { endpoint: 'https://fake.example.com/api', region: 'cn' }
};

/** 假视频适配器：记录提交的请求，按队列依次返回预设的任务状态。 */
export class FakeVideoProvider implements VideoModelProvider {
  readonly kind = 'video';
  readonly provider: ProviderDescriptor = FAKE_PROVIDER;
  /** 收到的全部提交请求。 */
  readonly submitted: VideoGenerationRequest[] = [];
  /** 预设的查询结果，每次查询取出第一项；耗尽后返回成功。 */
  readonly queryStates: RemoteJobState<VideoJobResult>[] = [];
  /** 测试连接时要抛出的错误；为 null 表示连接成功。 */
  connectionError: Error | null = null;
  /** 收到的测试连接凭据。 */
  readonly connectionChecks: ProviderCallContext[] = [];

  constructor(private readonly models: readonly ModelDescriptor<'video'>[] = [
    { code: 'fake-video', displayName: '假视频模型', kind: 'video', capability: FAKE_VIDEO_CAPABILITY }
  ]) {}

  async checkConnection(context: ProviderCallContext): Promise<void> {
    this.connectionChecks.push(context);
    if (this.connectionError !== null) {
      throw this.connectionError;
    }
  }

  listModels(): readonly ModelDescriptor<'video'>[] {
    return this.models;
  }

  getCapability(modelCode: string): VideoCapability | undefined {
    return this.models.find((model) => model.code === modelCode)?.capability;
  }

  validate(request: VideoGenerationRequest): readonly string[] {
    return this.getCapability(request.modelCode) === undefined ? [`没有模型 ${request.modelCode}。`] : [];
  }

  async submit(request: VideoGenerationRequest): Promise<RemoteJobRef> {
    this.submitted.push(request);
    return { modelCode: request.modelCode, remoteJobId: `fake-${this.submitted.length}` };
  }

  async query(): Promise<RemoteJobState<VideoJobResult>> {
    return (
      this.queryStates.shift() ?? {
        status: 'succeeded',
        result: { videoUrl: 'https://fake.example.com/video.mp4', durationSeconds: 5 },
        errorCategory: null,
        errorCode: null,
        errorMessage: null
      }
    );
  }
}

/** 假图像适配器：记录提交的请求，按队列依次返回预设的任务状态，耗尽后返回成功。 */
export class FakeImageProvider implements ImageModelProvider {
  readonly kind = 'image';
  readonly provider: ProviderDescriptor = FAKE_PROVIDER;
  readonly submitted: ImageGenerationRequest[] = [];
  readonly queryStates: RemoteJobState<ImageJobResult>[] = [];

  constructor(private readonly models: readonly ModelDescriptor<'image'>[] = [
    { code: 'fake-image', displayName: '假图像模型', kind: 'image', capability: FAKE_IMAGE_CAPABILITY }
  ]) {}

  listModels(): readonly ModelDescriptor<'image'>[] {
    return this.models;
  }

  getCapability(modelCode: string): ImageCapability | undefined {
    return this.models.find((model) => model.code === modelCode)?.capability;
  }

  validate(request: ImageGenerationRequest): readonly string[] {
    return this.getCapability(request.modelCode) === undefined ? [`没有模型 ${request.modelCode}。`] : [];
  }

  async submit(request: ImageGenerationRequest): Promise<RemoteJobRef> {
    this.submitted.push(request);
    return { modelCode: request.modelCode, remoteJobId: `fake-image-${this.submitted.length}` };
  }

  async query(): Promise<RemoteJobState<ImageJobResult>> {
    return (
      this.queryStates.shift() ?? {
        status: 'succeeded',
        result: { imageUrls: ['https://fake.example.com/image.png'] },
        errorCategory: null,
        errorCode: null,
        errorMessage: null
      }
    );
  }
}

/** 假音频适配器：记录提交的请求，查询按队列返回预设状态，耗尽后返回成功。 */
export class FakeAudioProvider implements AudioModelProvider {
  readonly kind = 'audio';
  readonly provider: ProviderDescriptor = FAKE_PROVIDER;
  readonly submitted: AudioGenerationRequest[] = [];
  readonly queryStates: RemoteJobState<AudioJobResult>[] = [];

  constructor(private readonly models: readonly ModelDescriptor<'audio'>[] = [
    { code: 'fake-audio', displayName: '假音频模型', kind: 'audio', capability: FAKE_AUDIO_CAPABILITY }
  ]) {}

  listModels(): readonly ModelDescriptor<'audio'>[] {
    return this.models;
  }

  getCapability(modelCode: string): AudioCapability | undefined {
    return this.models.find((model) => model.code === modelCode)?.capability;
  }

  validate(request: AudioGenerationRequest): readonly string[] {
    return this.getCapability(request.modelCode) === undefined ? [`没有模型 ${request.modelCode}。`] : [];
  }

  async submit(request: AudioGenerationRequest): Promise<RemoteJobRef> {
    this.submitted.push(request);
    return { modelCode: request.modelCode, remoteJobId: `fake-audio-${this.submitted.length}` };
  }

  async query(): Promise<RemoteJobState<AudioJobResult>> {
    return (
      this.queryStates.shift() ?? {
        status: 'succeeded',
        result: { audioUrl: 'https://fake.example.com/audio.wav', durationSeconds: 3.5 },
        errorCategory: null,
        errorCode: null,
        errorMessage: null
      }
    );
  }
}

/** 假文本模型的能力。 */
export const FAKE_TEXT_CAPABILITY: TextCapability = { contextTokens: 100000, maxOutputTokens: 8000, imageInput: true };

/** 假文本适配器：记录收到的请求，返回固定结果。 */
export class FakeTextProvider implements TextModelProvider {
  readonly kind = 'text';
  readonly provider: ProviderDescriptor = FAKE_PROVIDER;
  readonly requests: TextGenerationRequest[] = [];

  constructor(private readonly models: readonly ModelDescriptor<'text'>[] = [
    { code: 'fake-text', displayName: '假文本模型', kind: 'text', capability: FAKE_TEXT_CAPABILITY }
  ]) {}

  listModels(): readonly ModelDescriptor<'text'>[] {
    return this.models;
  }

  getCapability(modelCode: string): TextCapability | undefined {
    return this.models.find((model) => model.code === modelCode)?.capability;
  }

  async generate(_modelCode: string, request: TextGenerationRequest): Promise<unknown> {
    this.requests.push(request);
    return { title: '假结果' };
  }
}
