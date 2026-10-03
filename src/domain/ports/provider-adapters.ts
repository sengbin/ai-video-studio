// ------------------------------------------------------------------------
// 名称：provider-adapters.ts
// 说明：文本、图像、音频、视频模型适配器的端口接口：与模型无关的生成请求、远端任务引用与状态，以及各类适配器的统一方法（含可选的取消与测试连接）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：领域层只产出与模型无关的请求；每个适配器负责转换为服务商的字段并处理各家限制。失败一律抛出 ProviderError。
// ------------------------------------------------------------------------

import { ProviderFailure } from '../errors';
import { CapabilityByKind, GeneratedAudioKind, ModelKind, VideoAudioMode } from '../models/model-capability';
import { ModelDescriptor, ProviderDescriptor, ProviderSettings } from '../models/model-provider';
import { TextGenerationRequest } from './text-generation-port';

/** 随请求发送的素材文件（图片、音频）。适配器决定传输方式，如 Base64 内联或上传到临时存储。 */
export interface MediaInput {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** 调用服务商时使用的凭据与设置，由生成队列在每次调用前取得，不进入请求快照。 */
export interface ProviderCallContext {
  readonly apiKey: string;
  /** 服务商设置，如接口地址；键见适配器声明的 settingFields。 */
  readonly settings: ProviderSettings;
  /** 取消信号；触发后应尽快终止网络请求。 */
  readonly signal?: AbortSignal;
}

/** 已提交的远端任务的引用，用于轮询与取消。 */
export interface RemoteJobRef {
  readonly modelCode: string;
  readonly remoteJobId: string;
}

/** 远端任务状态：排队、处理中、成功、失败、已取消、已过期（服务商已不保留该任务）。 */
export type RemoteJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

/** 一次查询得到的远端任务状态；只有成功时才有 result，只有失败时才有错误信息。 */
export interface RemoteJobState<TResult> {
  readonly status: RemoteJobStatus;
  readonly result: TResult | null;
  /** 失败分类，用于决定是否重试；非失败状态为 null。 */
  readonly errorCategory: ProviderFailure | null;
  /** 服务商返回的错误码。 */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

/** 视频生成请求。字段为 null 表示不指定，由模型使用默认值。 */
export interface VideoGenerationRequest {
  readonly modelCode: string;
  readonly prompt: string;
  readonly firstFrame: MediaInput | null;
  readonly lastFrame: MediaInput | null;
  readonly referenceImages: readonly MediaInput[];
  /** 参考音频（音色参考）。 */
  readonly referenceAudios: readonly MediaInput[];
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  /** 视频时长，单位为秒。 */
  readonly durationSeconds: number | null;
  readonly audioMode: VideoAudioMode | null;
  readonly seed: number | null;
  /** 模型专有参数，键与取值由适配器校验。 */
  readonly extraParams: Readonly<Record<string, unknown>>;
}

/** 视频生成结果。 */
export interface VideoJobResult {
  /** 结果视频地址，通常有有效期，需要及时下载。 */
  readonly videoUrl: string;
  readonly durationSeconds: number | null;
}

/** 图像生成请求。 */
export interface ImageGenerationRequest {
  readonly modelCode: string;
  readonly prompt: string;
  readonly negativePrompt: string | null;
  readonly referenceImages: readonly MediaInput[];
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  /** 生成图片数量。 */
  readonly count: number;
  readonly seed: number | null;
  readonly extraParams: Readonly<Record<string, unknown>>;
}

/** 图像生成结果。 */
export interface ImageJobResult {
  readonly imageUrls: readonly string[];
}

/** 音频生成请求。 */
export interface AudioGenerationRequest {
  readonly modelCode: string;
  readonly audioKind: GeneratedAudioKind;
  /** 要朗读的文字，或对配乐、音效的描述。 */
  readonly prompt: string;
  readonly durationSeconds: number | null;
  readonly language: string | null;
  /** 预置音色。 */
  readonly voice: string | null;
  readonly referenceAudio: MediaInput | null;
  readonly extraParams: Readonly<Record<string, unknown>>;
}

/** 音频生成结果。 */
export interface AudioJobResult {
  readonly audioUrl: string;
  readonly durationSeconds: number | null;
}

/** 各类适配器的共同部分：模型类型、服务商声明、模型清单与可选的测试连接。 */
export interface ProviderAdapterBase<TKind extends ModelKind> {
  /** 适配器的模型类型。 */
  readonly kind: TKind;
  /** 服务商信息；同一服务商的各类型适配器必须声明相同的内容。 */
  readonly provider: ProviderDescriptor;

  /** 适配器提供的模型及其能力。 */
  listModels(): readonly ModelDescriptor<TKind>[];

  /** 取某个模型的能力；模型不存在返回 undefined。 */
  getCapability(modelCode: string): CapabilityByKind[TKind] | undefined;

  /**
   * 用凭据向服务商发一次轻量请求，确认接口地址和访问密钥可用；服务商不支持时不实现。
   * @throws ProviderError 鉴权、网络、服务端等失败，或接口地址不正确。
   */
  checkConnection?(context: ProviderCallContext): Promise<void>;
}

/** 文本模型适配器：同步生成，一次请求直接返回结果，不经过任务队列。 */
export interface TextModelProvider extends ProviderAdapterBase<'text'> {
  /**
   * 发送请求并返回模型通过输出工具提交的参数对象，内容未经校验。
   * @param modelCode 服务商侧的模型标识。
   * @param request 生成请求。
   * @param context 凭据、设置与取消信号。
   * @throws ProviderError 鉴权、限流、参数、内容审核、服务端或网络失败，或模型没有通过工具返回。
   */
  generate(modelCode: string, request: TextGenerationRequest, context: ProviderCallContext): Promise<unknown>;
}

/** 图像、音频、视频适配器的共同方法，均为异步任务式：提交后取得任务引用，再轮询状态。 */
export interface ModelProvider<TKind extends ModelKind, TRequest, TResult> extends ProviderAdapterBase<TKind> {
  /**
   * 提交前按模型能力校验请求，不发起网络调用。
   * @returns 问题列表，逐条说明如何修正；没有问题返回空数组。
   */
  validate(request: TRequest): readonly string[];

  /**
   * 提交生成任务。
   * @throws ProviderError 鉴权、限流、参数、内容审核、服务端或网络失败。
   */
  submit(request: TRequest, context: ProviderCallContext): Promise<RemoteJobRef>;

  /**
   * 查询任务状态；任务失败不抛出，而是通过返回的状态表达。
   * @throws ProviderError 查询请求本身失败。
   */
  query(ref: RemoteJobRef, context: ProviderCallContext): Promise<RemoteJobState<TResult>>;

  /**
   * 取消任务；服务商不支持取消时不实现该方法。
   * @throws ProviderError 取消请求失败。
   */
  cancel?(ref: RemoteJobRef, context: ProviderCallContext): Promise<void>;
}

/** 图像模型适配器。 */
export type ImageModelProvider = ModelProvider<'image', ImageGenerationRequest, ImageJobResult>;

/** 音频模型适配器。 */
export type AudioModelProvider = ModelProvider<'audio', AudioGenerationRequest, AudioJobResult>;

/** 视频模型适配器。 */
export type VideoModelProvider = ModelProvider<'video', VideoGenerationRequest, VideoJobResult>;

/** 模型类型与适配器类型的对应。 */
export interface ProviderAdapterByKind {
  readonly text: TextModelProvider;
  readonly image: ImageModelProvider;
  readonly audio: AudioModelProvider;
  readonly video: VideoModelProvider;
}

/** 任一类型的适配器。 */
export type AnyModelProvider = ProviderAdapterByKind[ModelKind];

/** 调用一个视频模型所需的内容：适配器、凭据与设置、服务商侧的模型代码。 */
export interface ResolvedCall<TAdapter> {
  readonly adapter: TAdapter;
  readonly context: ProviderCallContext;
  readonly modelCode: string;
}

/** 调用一个文本模型所需的内容。 */
export type ResolvedTextCall = ResolvedCall<TextModelProvider>;

/** 调用一个视频模型所需的内容。 */
export type ResolvedVideoCall = ResolvedCall<VideoModelProvider>;

/** 调用一个图像模型所需的内容。 */
export type ResolvedImageCall = ResolvedCall<ImageModelProvider>;

/** 调用一个音频模型所需的内容。 */
export type ResolvedAudioCall = ResolvedCall<AudioModelProvider>;
