// ------------------------------------------------------------------------
// 名称：generation-profile.ts
// 说明：生成参数的领域模型：作品级、集级、镜头组级参数值（模型、画幅、分辨率、声音模式、声音内容、随机种子、本组生成时长、负向清单、提示词改写），以及合并后的生效参数与每个值的来源。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 generation_profiles 表（作品、集、镜头组三级覆盖，生效时本组 → 本集 → 作品 → 项目默认）；字段为 null 表示沿用上一级。
// ------------------------------------------------------------------------

import { VideoAudioElement, VideoAudioMode } from './model-capability';

/** 可保存参数的范围：作品默认、本集覆盖、本组覆盖（镜头组是视频生成的单位）。 */
export type ProfileScope = 'work' | 'episode' | 'group';

/** 目前可保存的参数字段。 */
export const PROFILE_FIELDS = ['modelId', 'aspectRatio', 'resolution', 'audioMode', 'audioElements', 'seed', 'durationSeconds', 'negativeList', 'promptExtend'] as const;

/** 参数字段名。 */
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** 随机种子的取值上限（含）：32 位有符号整数的最大值；各模型的实际范围由适配器校验。 */
export const SEED_MAX = 2147483647;

/** 负向清单的最大长度（字符）。 */
export const NEGATIVE_LIST_MAX_LENGTH = 300;

/** 默认的负向清单：只放最稳妥的两项；官方建议负向清单只写不希望出现的内容，不必凑数。 */
export const DEFAULT_NEGATIVE_LIST = '不要字幕，不要水印';

/** 参数页签里可一键加入负向清单的常用项，取自千问官方提示词指南的“常见负向”。 */
export const NEGATIVE_LIST_PRESETS: readonly string[] = [
  '不要字幕',
  '不要水印',
  '不要人脸变形',
  '不要多余手指',
  '不要肢体扭曲',
  '不要低清晰度',
  '不要频繁切镜',
  '不要空间混乱'
];

/** 镜头组指定生成时长的上限（秒），仅作输入合理性检查；模型支持的范围在提交时按模型能力校验。 */
export const GROUP_DURATION_MAX_SECONDS = 3600;

/** 只能在镜头组范围保存的参数字段：每组的镜头总时长不同，作品、集共用同一个时长没有意义。 */
export const GROUP_ONLY_FIELDS: readonly ProfileField[] = ['durationSeconds'];

/** 某一级保存的参数值；null 表示沿用上一级。 */
export interface ProfileValues {
  readonly modelId: number | null;
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly audioMode: VideoAudioMode | null;
  /** 声音模式为模型原生生成时传给模型的声音内容（按固定顺序、至少一项）；null 表示沿用上一级，最终仍为空时取模型支持的全部。 */
  readonly audioElements: readonly VideoAudioElement[] | null;
  /** 随机种子，0 至 SEED_MAX；null 表示沿用上一级，最终仍为空时不传（随机）。 */
  readonly seed: number | null;
  /** 本组生成时长（秒），仅镜头组可设置；null 表示按组内镜头总时长向上对齐到模型支持的取值。 */
  readonly durationSeconds: number | null;
  /** 负向清单：不希望出现的内容，如“不要字幕，不要水印”，编译时写在提示词末尾；null 表示沿用上一级，空串表示明确不要负向清单，最终仍为 null 时用默认清单。 */
  readonly negativeList: string | null;
  /** 是否让平台改写提示词（prompt_extend）；null 表示沿用上一级，最终仍为 null 时不传，由平台用默认值（开启）。 */
  readonly promptExtend: boolean | null;
}

/** 没有设置任何值。 */
export const EMPTY_PROFILE: ProfileValues = {
  modelId: null,
  aspectRatio: null,
  resolution: null,
  audioMode: null,
  audioElements: null,
  seed: null,
  durationSeconds: null,
  negativeList: null,
  promptExtend: null
};

/** 参数的保存位置。 */
export type ProfileTarget =
  | { readonly scope: 'work'; readonly workId: number }
  | { readonly scope: 'episode'; readonly episodeId: number }
  | { readonly scope: 'group'; readonly groupId: number };

/** 生效值的来源：本组覆盖、本集覆盖、作品默认、项目默认；都没有设置为 none。 */
export type ProfileSource = 'group' | 'episode' | 'work' | 'project' | 'none';

/** 合并后的生效参数与每个值的来源。 */
export interface EffectiveProfile {
  readonly values: ProfileValues;
  readonly sources: Readonly<Record<ProfileField, ProfileSource>>;
}
