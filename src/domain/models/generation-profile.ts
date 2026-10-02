// ------------------------------------------------------------------------
// 名称：generation-profile.ts
// 说明：生成参数的领域模型：作品级、集级参数值，以及合并后的生效参数与每个值的来源。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 generation_profiles 表（作品、集、镜头组三级覆盖，生效时本组 → 本集 → 作品 → 项目默认）；字段为 null 表示沿用上一级。
// ------------------------------------------------------------------------

import { VideoAudioMode } from './model-capability';

/** 可保存参数的范围：作品默认、本集覆盖、本组覆盖（镜头组是视频生成的单位）。 */
export type ProfileScope = 'work' | 'episode' | 'group';

/** 目前可保存的参数字段。 */
export const PROFILE_FIELDS = ['modelId', 'aspectRatio', 'resolution', 'audioMode'] as const;

/** 参数字段名。 */
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** 某一级保存的参数值；null 表示沿用上一级。 */
export interface ProfileValues {
  readonly modelId: number | null;
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly audioMode: VideoAudioMode | null;
}

/** 没有设置任何值。 */
export const EMPTY_PROFILE: ProfileValues = { modelId: null, aspectRatio: null, resolution: null, audioMode: null };

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
