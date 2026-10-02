// ------------------------------------------------------------------------
// 名称：qianwen-image-provider.ts
// 说明：千问AI平台图像适配器：按模型能力校验请求，把与模型无关的图像生成请求转换为 image-generation 异步任务，并查询任务状态；用查询不存在的任务来测试连接。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：参考图以 Base64 内联传输；平台文档未提供取消接口，因此不实现 cancel；结果图片地址 24 小时后过期。
// ------------------------------------------------------------------------

import { ProviderError } from '../../../domain/errors';
import { ImageCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../../domain/models/model-provider';
import {
  ImageGenerationRequest,
  ImageJobResult,
  ImageModelProvider,
  ProviderCallContext,
  RemoteJobRef,
  RemoteJobState
} from '../../../domain/ports/provider-adapters';
import { FetchFunction, QianwenApiClient } from './qianwen-api-client';
import { QIANWEN_PROVIDER } from './qianwen-catalog';
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_RESOLUTION_TIER,
  IMAGE_CREATE_TASK_PATH,
  IMAGE_REFERENCE_MAX_BYTES,
  IMAGE_SEED_MAX,
  IMAGE_SIZE_STEP,
  NEGATIVE_PROMPT_MAX_LENGTH,
  QIANWEN_IMAGE_MODELS,
  QianwenImageModel,
  RESOLUTION_TIER_PIXELS
} from './qianwen-image-catalog';
import {
  ASYNC_HEADERS,
  CONNECTION_PROBE_PATH,
  QUERY_TASK_PATH,
  buildTaskState,
  mapExtraParams,
  readObject,
  readTaskId,
  toDataUri,
  validateExtraParams,
  validateMediaFiles
} from './qianwen-protocol';

/** 千问AI平台的图像适配器。 */
export class QianwenImageProvider implements ImageModelProvider {
  readonly kind = 'image';
  readonly provider: ProviderDescriptor = QIANWEN_PROVIDER;
  private readonly client: QianwenApiClient;

  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   */
  constructor(fetchFunction?: FetchFunction) {
    this.client = new QianwenApiClient(fetchFunction);
  }

  listModels(): readonly ModelDescriptor<'image'>[] {
    return QIANWEN_IMAGE_MODELS.map((model) => model.descriptor);
  }

  getCapability(modelCode: string): ImageCapability | undefined {
    return findModel(modelCode)?.descriptor.capability;
  }

  validate(request: ImageGenerationRequest): readonly string[] {
    const model = findModel(request.modelCode);
    if (model === undefined) {
      return [`千问AI平台没有模型 ${request.modelCode}。`];
    }
    return [
      ...validatePromptAndMedia(request, model),
      ...validateParameters(request, model),
      ...validateExtraParams(request.extraParams, model.extraParams)
    ];
  }

  async submit(request: ImageGenerationRequest, context: ProviderCallContext): Promise<RemoteJobRef> {
    const issues = this.validate(request);
    if (issues.length > 0) {
      throw new ProviderError('invalid_request', issues.join('；'));
    }
    // 校验已确认模型存在。
    const model = findModel(request.modelCode) as QianwenImageModel;
    const response = await this.client.postJson(context, IMAGE_CREATE_TASK_PATH, buildRequestBody(request, model), ASYNC_HEADERS);
    return { modelCode: request.modelCode, remoteJobId: readTaskId(response) };
  }

  checkConnection(context: ProviderCallContext): Promise<void> {
    return this.client.checkConnection(context, CONNECTION_PROBE_PATH);
  }

  async query(ref: RemoteJobRef, context: ProviderCallContext): Promise<RemoteJobState<ImageJobResult>> {
    const response = await this.client.getJson(context, `${QUERY_TASK_PATH}/${encodeURIComponent(ref.remoteJobId)}`);
    const output = readObject(response.output);
    return buildTaskState(output, () => {
      const imageUrls = readImageUrls(output);
      if (imageUrls.length === 0) {
        throw new ProviderError('server', '任务已成功，但千问AI平台没有返回图片地址。');
      }
      return { imageUrls };
    });
  }
}

function findModel(modelCode: string): QianwenImageModel | undefined {
  return QIANWEN_IMAGE_MODELS.find((model) => model.descriptor.code === modelCode);
}

/** 校验提示词、反向提示词和参考图。 */
function validatePromptAndMedia(request: ImageGenerationRequest, model: QianwenImageModel): string[] {
  const issues: string[] = [];
  const capability = model.descriptor.capability;
  if (request.prompt.trim() === '') {
    issues.push('提示词不能为空。');
  }
  if (request.prompt.length > capability.promptMaxLength) {
    issues.push(`提示词不能超过 ${capability.promptMaxLength} 字（当前 ${request.prompt.length} 字）。`);
  }
  if (request.negativePrompt !== null) {
    if (!model.negativePrompt) {
      issues.push('该模型不支持反向提示词。');
    } else if (request.negativePrompt.length > NEGATIVE_PROMPT_MAX_LENGTH) {
      issues.push(`反向提示词不能超过 ${NEGATIVE_PROMPT_MAX_LENGTH} 字（当前 ${request.negativePrompt.length} 字）。`);
    }
  }
  if (request.referenceImages.length > 0 && capability.referenceImagesMax === 0) {
    issues.push('该模型不支持参考图。');
  } else if (request.referenceImages.length > capability.referenceImagesMax) {
    issues.push(`参考图最多 ${capability.referenceImagesMax} 张（当前 ${request.referenceImages.length} 张）。`);
  }
  issues.push(...validateMediaFiles(request.referenceImages, 'image/', '图片', IMAGE_REFERENCE_MAX_BYTES));
  return issues;
}

/** 校验画幅、分辨率、数量和随机种子是否在模型能力范围内。 */
function validateParameters(request: ImageGenerationRequest, model: QianwenImageModel): string[] {
  const issues: string[] = [];
  const capability = model.descriptor.capability;
  if (request.aspectRatio !== null && !capability.aspectRatios.includes(request.aspectRatio)) {
    issues.push(`画幅 ${request.aspectRatio} 不在模型支持的范围内：${capability.aspectRatios.join('、')}。`);
  }
  if (request.resolution !== null) {
    if (!capability.resolutions.includes(request.resolution)) {
      issues.push(`分辨率 ${request.resolution} 不在模型支持的范围内：${capability.resolutions.join('、')}。`);
    } else if (request.referenceImages.length > 0 && model.textOnlyResolutions.includes(request.resolution)) {
      issues.push(`分辨率 ${request.resolution} 只能用于不带参考图的文生图。`);
    }
  }
  if (!Number.isInteger(request.count) || request.count < 1 || request.count > capability.imagesPerRequestMax) {
    issues.push(`生成数量必须是 1 到 ${capability.imagesPerRequestMax} 之间的整数（当前 ${request.count}）。`);
  }
  if (request.seed !== null && (!capability.seed || !Number.isInteger(request.seed) || request.seed < 0 || request.seed > IMAGE_SEED_MAX)) {
    issues.push(`随机种子必须是 0 到 ${IMAGE_SEED_MAX} 之间的整数，且模型需支持随机种子。`);
  }
  return issues;
}

/** 按画幅和总像素数计算“宽*高”，宽高取 IMAGE_SIZE_STEP 的整数倍并向下取整，保证总像素不超过档位。 */
function toPixelSize(aspectRatio: string, totalPixels: number): string {
  const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
  const width = Math.floor(Math.sqrt((totalPixels * ratioWidth) / ratioHeight) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
  const height = Math.floor(Math.sqrt((totalPixels * ratioHeight) / ratioWidth) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
  return `${width}*${height}`;
}

/**
 * 决定请求体中的 size：都没指定时不传，由模型自行决定；
 * 只指定分辨率且模型接受档位写法时直接传档位（输出按最后一张参考图的宽高比缩放）；其余情况换算成“宽*高”。
 */
function resolveSize(request: ImageGenerationRequest, model: QianwenImageModel): string | undefined {
  if (request.aspectRatio === null && request.resolution === null) {
    return undefined;
  }
  if (request.aspectRatio === null && model.tierSize && request.resolution !== null) {
    return request.resolution;
  }
  const tier = request.resolution ?? DEFAULT_RESOLUTION_TIER;
  return toPixelSize(request.aspectRatio ?? DEFAULT_ASPECT_RATIO, RESOLUTION_TIER_PIXELS[tier]);
}

/** 构造创建任务的请求体；null 的参数不写入，由平台使用默认值。 */
function buildRequestBody(request: ImageGenerationRequest, model: QianwenImageModel): Record<string, unknown> {
  const content: Array<Record<string, string>> = [{ text: request.prompt }];
  for (const image of request.referenceImages) content.push({ image: toDataUri(image) });

  const parameters: Record<string, unknown> = { n: request.count };
  const size = resolveSize(request, model);
  if (size !== undefined) parameters.size = size;
  if (request.negativePrompt !== null) parameters.negative_prompt = request.negativePrompt;
  if (request.seed !== null) parameters.seed = request.seed;
  Object.assign(parameters, mapExtraParams(request.extraParams, model.extraParams));

  return { model: request.modelCode, input: { messages: [{ role: 'user', content }] }, parameters };
}

/** 读取结果图片地址：万相 2.7 在 choices[].message.content[].image，千问图像在 results[].url。 */
function readImageUrls(output: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const choice of Array.isArray(output.choices) ? output.choices : []) {
    const content = readObject(readObject(choice).message).content;
    for (const item of Array.isArray(content) ? content : []) {
      const image = readObject(item).image;
      if (typeof image === 'string' && image !== '') urls.push(image);
    }
  }
  for (const result of Array.isArray(output.results) ? output.results : []) {
    const url = readObject(result).url;
    if (typeof url === 'string' && url !== '') urls.push(url);
  }
  return urls;
}
