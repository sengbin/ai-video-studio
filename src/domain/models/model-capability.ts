// ------------------------------------------------------------------------
// 名称：model-capability.ts
// 说明：模型类型（文本、图像、音频、视频）与按类型区分的模型能力描述：上下文、画幅、分辨率、时长、首尾帧、参考素材、声音等。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：字段含义与 docs/database-design.md 4.6 一致；入库的 JSON 使用 snake_case 键，转换见 rules/model-capability-rules.ts。
// ------------------------------------------------------------------------

/** 模型类型：文本、图像、音频、视频。 */
export const MODEL_KINDS = ['text', 'image', 'audio', 'video'] as const;

/** 模型类型。 */
export type ModelKind = (typeof MODEL_KINDS)[number];

/** 模型类型的显示名称。 */
export const MODEL_KIND_LABELS: Readonly<Record<ModelKind, string>> = {
  text: '文本',
  image: '图像',
  audio: '音频',
  video: '视频'
};

/** 提示词语言。 */
export type PromptLanguage = 'zh' | 'en';

/** 视频原生声音模式：无声、模型原生生成。 */
export type VideoAudioMode = 'none' | 'native';

/** 视频原生声音内容。 */
export type VideoAudioElement = 'dialogue' | 'narration' | 'sfx' | 'music';

/** 全部视频原生声音内容，按界面显示与提示词编译的固定顺序排列。 */
export const VIDEO_AUDIO_ELEMENTS: readonly VideoAudioElement[] = ['dialogue', 'narration', 'sfx', 'music'];

/** 视频原生声音内容的显示名称。 */
export const VIDEO_AUDIO_ELEMENT_LABELS: Readonly<Record<VideoAudioElement, string>> = {
  dialogue: '对白',
  narration: '旁白',
  sfx: '音效',
  music: '配乐'
};

/** 请求中的时长取此值，表示由模型自动决定（智能时长），仅当能力的 allowAuto 为 true 时可用。 */
export const AUTO_DURATION_SECONDS = -1;

/** 音频模型可生成的音频类型：音色参考、配乐、音效。 */
export type GeneratedAudioKind = 'voice' | 'music' | 'sfx';

/** 时长约束：给出范围（min、max、step）或离散的可选值（options），二者提供其一。 */
export interface DurationCapability {
  readonly min?: number;
  readonly max?: number;
  /** 范围内允许的步长，如整数秒为 1。 */
  readonly step?: number;
  readonly options?: readonly number[];
  /** 是否支持由模型自动决定时长（智能时长）。 */
  readonly allowAuto?: boolean;
}

/** 参考音频输入的限制。 */
export interface AudioInputLimit {
  /** 最多可传入的参考音频数量。 */
  readonly count: number;
  /** 参考音频的时长上限，单位为秒。 */
  readonly maxSeconds: number;
}

/** 视频模型的能力。 */
export interface VideoCapability {
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly duration: DurationCapability;
  readonly fps: readonly number[];
  readonly audioModes: readonly VideoAudioMode[];
  readonly audioElements: readonly VideoAudioElement[];
  /** 是否支持音色参考音频输入。 */
  readonly voiceReference: boolean;
  /** 参考音频限制；null 表示不支持参考音频。 */
  readonly audioInputMax: AudioInputLimit | null;
  readonly firstFrame: boolean;
  readonly lastFrame: boolean;
  /** 参考图数量上限；0 表示不支持参考图。 */
  readonly referenceImagesMax: number;
  /** 是否支持随机种子：为 false 时生成参数不能设置种子；取值范围由适配器校验。 */
  readonly seed: boolean;
  /** 是否支持让平台改写提示词（prompt_extend）；缺省为不支持。 */
  readonly promptExtend?: boolean;
  /** 有首帧时视频画幅是否跟随首帧图片：为 true 时不再传画幅（平台按首帧自适应），提交时给出提醒。 */
  readonly firstFrameDefinesAspect?: boolean;
  readonly promptLanguages: readonly PromptLanguage[];
  readonly promptMaxLength: number;
}

/** 图像模型的能力。 */
export interface ImageCapability {
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly imagesPerRequestMax: number;
  readonly referenceImagesMax: number;
  readonly seed: boolean;
  readonly promptLanguages: readonly PromptLanguage[];
  readonly promptMaxLength: number;
}

/** 音频模型的能力。 */
export interface AudioCapability {
  readonly audioKinds: readonly GeneratedAudioKind[];
  readonly duration: DurationCapability;
  /** 支持的语言（仅音色参考）。 */
  readonly languages: readonly string[];
  /** 可选的预置音色。 */
  readonly voices: readonly string[];
  /** 是否支持参考音频输入。 */
  readonly referenceAudio: boolean;
  readonly promptLanguages: readonly PromptLanguage[];
  readonly promptMaxLength: number;
}

/** 文本模型的能力。 */
export interface TextCapability {
  /** 上下文窗口大小（输入与输出共用），单位为 token。 */
  readonly contextTokens: number;
  /** 单次回复的最大输出 token 数。 */
  readonly maxOutputTokens: number;
  /** 是否支持随请求发送图片。 */
  readonly imageInput: boolean;
}

/** 模型类型对应的能力类型。 */
export interface CapabilityByKind {
  readonly text: TextCapability;
  readonly video: VideoCapability;
  readonly image: ImageCapability;
  readonly audio: AudioCapability;
}

/** 任一类型的模型能力。 */
export type ModelCapability = CapabilityByKind[ModelKind];
