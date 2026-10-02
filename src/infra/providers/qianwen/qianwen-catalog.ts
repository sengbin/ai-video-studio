// ------------------------------------------------------------------------
// 名称：qianwen-catalog.ts
// 说明：千问AI平台服务商的声明与模型目录：服务商代码、接口地址设置项，以及万相 3.0 视频模型的能力描述。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：能力数值来自千问AI平台文档“wan3.0-video 视频生成”；平台上新增或调整模型时只改这里。
// ------------------------------------------------------------------------

import { VideoCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../../domain/models/model-provider';

/** 服务商代码，同时用于数据库和密钥名称。 */
export const QIANWEN_PROVIDER_CODE = 'qianwen';

/** 接口地址设置项的键。 */
export const QIANWEN_ENDPOINT_SETTING_KEY = 'endpoint';

/** 接口地址的默认值。 */
const QIANWEN_DEFAULT_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1';

/** 接口地址必须以 /api/v1 结尾：视频、图像生成用平台原生接口，不是 compatible-mode，也不含具体接口路径。 */
export const QIANWEN_ENDPOINT_PATTERN = '/api/v1$';
export const QIANWEN_ENDPOINT_MESSAGE = '接口地址必须以 /api/v1 结尾（如 https://maas.qianwenaiapi.com/api/v1），不要填 compatible-mode 地址或具体接口路径。';

/** 千问AI平台的服务商声明。 */
export const QIANWEN_PROVIDER: ProviderDescriptor = {
  code: QIANWEN_PROVIDER_CODE,
  displayName: '千问AI平台',
  settingFields: [
    {
      key: QIANWEN_ENDPOINT_SETTING_KEY,
      label: '接口地址',
      description: '千问AI平台的原生 API 地址，必须以 https:// 开头、/api/v1 结尾，不是 compatible-mode 地址。',
      control: 'text',
      defaultValue: QIANWEN_DEFAULT_ENDPOINT,
      format: 'https-url',
      pattern: QIANWEN_ENDPOINT_PATTERN,
      patternMessage: QIANWEN_ENDPOINT_MESSAGE
    }
  ]
};

/** 万相 3.0 视频生成的单张参考图大小上限，单位为字节。 */
export const WAN3_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 万相 3.0 视频生成的单段参考音频大小上限，单位为字节。 */
export const WAN3_AUDIO_MAX_BYTES = 15 * 1024 * 1024;

/** 随机种子的取值上限。 */
export const WAN3_SEED_MAX = 2147483647;

/** 提示词长度上限。 */
const WAN3_PROMPT_MAX_LENGTH = 20000;

/** 万相 3.0 视频生成的能力。画幅不含 adaptive：不指定画幅时模型按输入素材自适应。 */
const WAN3_VIDEO_CAPABILITY: VideoCapability = {
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  resolutions: ['480P', '720P', '1080P'],
  duration: { min: 2, max: 30, step: 1, allowAuto: true },
  fps: [30],
  audioModes: ['none', 'native'],
  audioElements: ['dialogue', 'narration', 'sfx', 'music'],
  voiceReference: true,
  audioInputMax: { count: 5, maxSeconds: 15 },
  firstFrame: true,
  lastFrame: true,
  referenceImagesMax: 10,
  seed: true,
  promptLanguages: ['zh', 'en'],
  promptMaxLength: WAN3_PROMPT_MAX_LENGTH
};

/** 千问AI平台提供的视频模型。 */
export const QIANWEN_VIDEO_MODELS: readonly ModelDescriptor<'video'>[] = [
  { code: 'wan3.0-video', displayName: '万相 3.0 视频', kind: 'video', capability: WAN3_VIDEO_CAPABILITY },
  { code: 'wan3.0-video-prime', displayName: '万相 3.0 视频（高速版）', kind: 'video', capability: WAN3_VIDEO_CAPABILITY }
];
