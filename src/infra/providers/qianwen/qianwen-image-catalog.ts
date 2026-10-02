// ------------------------------------------------------------------------
// 名称：qianwen-image-catalog.ts
// 说明：千问AI平台图像模型目录：千问图像 3.0 与万相 2.7 图像两个系列共四个模型的能力描述，以及各模型在请求构造上的差异。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：数值来自千问AI平台文档“Qwen — 异步图像生成（3.0系列）”“Wan 2.7 — 创建任务”；平台新增或调整图像模型时只改这里。
// ------------------------------------------------------------------------

import { ImageCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor } from '../../../domain/models/model-provider';
import { ExtraParamSpec } from './qianwen-protocol';

/** 随机种子的取值上限。 */
export const IMAGE_SEED_MAX = 2147483647;

/** 单张参考图的大小上限，单位为字节。 */
export const IMAGE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;

/** 反向提示词的长度上限。 */
export const NEGATIVE_PROMPT_MAX_LENGTH = 500;

/** 输出宽高取此数的整数倍，避免出现平台不接受的奇数尺寸。 */
export const IMAGE_SIZE_STEP = 16;

/** 分辨率档位与对应的总像素数（如 1K 即 1024×1024 个像素）。 */
export const RESOLUTION_TIER_PIXELS: Readonly<Record<string, number>> = {
  '1K': 1024 * 1024,
  '2K': 2048 * 2048,
  '4K': 4096 * 4096
};

/** 指定画幅但没有指定分辨率时使用的档位，与平台默认一致。 */
export const DEFAULT_RESOLUTION_TIER = '2K';

/** 指定分辨率但没有指定画幅时使用的画幅。 */
export const DEFAULT_ASPECT_RATIO = '1:1';

/** 提交任务的接口路径。 */
export const IMAGE_CREATE_TASK_PATH = '/services/aigc/image-generation/generation';

/** 两个系列共有的画幅，宽高比都在平台允许的 1:8 到 8:1 之内。 */
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

/** 水印开关：两个系列都支持，平台默认不加。 */
const WATERMARK_SPEC: ExtraParamSpec = { apiKey: 'watermark', allowed: [true, false] };

/** 一个图像模型的声明及其在请求构造上的差异。 */
export interface QianwenImageModel {
  readonly descriptor: ModelDescriptor<'image'>;
  /** 是否支持反向提示词。 */
  readonly negativePrompt: boolean;
  /** 输出尺寸能否直接写成 1K、2K、4K 档位；不能时只能写成“宽*高”。 */
  readonly tierSize: boolean;
  /** 只有不带参考图（纯文生图）时才能使用的分辨率档位。 */
  readonly textOnlyResolutions: readonly string[];
  /** 模型专有参数。 */
  readonly extraParams: Readonly<Record<string, ExtraParamSpec>>;
}

/** 千问图像 3.0 系列：只支持文生图，单次最多 6 张。 */
function qwenImageCapability(): ImageCapability {
  return {
    aspectRatios: ASPECT_RATIOS,
    resolutions: ['1K', '2K'],
    imagesPerRequestMax: 6,
    referenceImagesMax: 0,
    seed: true,
    promptLanguages: ['zh', 'en'],
    promptMaxLength: 4500
  };
}

/** 万相 2.7 图像：支持最多 9 张参考图，单次最多 4 张。 */
function wanImageCapability(resolutions: readonly string[]): ImageCapability {
  return {
    aspectRatios: ASPECT_RATIOS,
    resolutions,
    imagesPerRequestMax: 4,
    referenceImagesMax: 9,
    seed: true,
    promptLanguages: ['zh', 'en'],
    promptMaxLength: 5000
  };
}

/** 千问图像 3.0 的专有参数：提示词改写、水印。 */
const QWEN_IMAGE_EXTRA_PARAMS: Readonly<Record<string, ExtraParamSpec>> = {
  promptExtend: { apiKey: 'prompt_extend', allowed: [true, false] },
  watermark: WATERMARK_SPEC
};

/** 万相 2.7 的专有参数：思考模式（仅无参考图的文生图生效）、水印。 */
const WAN_IMAGE_EXTRA_PARAMS: Readonly<Record<string, ExtraParamSpec>> = {
  thinkingMode: { apiKey: 'thinking_mode', allowed: [true, false] },
  watermark: WATERMARK_SPEC
};

/** 千问AI平台提供的图像模型。 */
export const QIANWEN_IMAGE_MODELS: readonly QianwenImageModel[] = [
  {
    descriptor: { code: 'qwen-image-3.0-pro', displayName: '千问图像 3.0 Pro', kind: 'image', capability: qwenImageCapability() },
    negativePrompt: true,
    tierSize: false,
    textOnlyResolutions: [],
    extraParams: QWEN_IMAGE_EXTRA_PARAMS
  },
  {
    descriptor: { code: 'qwen-image-3.0', displayName: '千问图像 3.0', kind: 'image', capability: qwenImageCapability() },
    negativePrompt: true,
    tierSize: false,
    textOnlyResolutions: [],
    extraParams: QWEN_IMAGE_EXTRA_PARAMS
  },
  {
    descriptor: { code: 'wan2.7-image-pro', displayName: '万相 2.7 图像 Pro', kind: 'image', capability: wanImageCapability(['1K', '2K', '4K']) },
    negativePrompt: false,
    tierSize: true,
    textOnlyResolutions: ['4K'],
    extraParams: WAN_IMAGE_EXTRA_PARAMS
  },
  {
    descriptor: { code: 'wan2.7-image', displayName: '万相 2.7 图像', kind: 'image', capability: wanImageCapability(['1K', '2K']) },
    negativePrompt: false,
    tierSize: true,
    textOnlyResolutions: [],
    extraParams: WAN_IMAGE_EXTRA_PARAMS
  }
];
