// ------------------------------------------------------------------------
// 名称：storyboard.ts
// 说明：分镜脚本阶段的领域模型：生成参数、镜头与镜头声音的草稿与已保存记录、用户编辑提交的内容。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 storyboard_scripts、shots、shot_entities、shot_sounds 表；镜头引用实体用实体标识，不用名称。
// ------------------------------------------------------------------------

import { EntityKind } from './screenplay';

/** 镜头声音的类型：角色对白、旁白、音效、背景音乐。 */
export type SoundKind = 'dialogue' | 'narration' | 'sfx' | 'music';

/** 声音类型的界面名称，顺序即界面与提示词中的顺序。 */
export const SOUND_KIND_LABELS: Readonly<Record<SoundKind, string>> = {
  dialogue: '角色对白',
  narration: '旁白',
  sfx: '音效',
  music: '背景音乐'
};

/** 镜头首帧来源：无、上一镜头尾帧、指定资产图（只能由用户在镜头编辑里指定，生成不会产出）。 */
export type FirstFrameMode = 'none' | 'prev_tail' | 'asset';

/** 镜头连贯策略：无；尾帧接首帧；由模型逐个镜头判断。 */
export type ContinuityStrategy = 'none' | 'prev_tail' | 'ai';

/** 声音模式：无声；模型原生生成。 */
export type AudioMode = 'none' | 'native';

/** 分镜脚本阶段的生成参数，已经过规范化。 */
export interface StoryboardParams {
  /** 本次生成自定义的画面风格；null 表示沿用项目视觉风格（项目也没有设置时不指定风格）。 */
  readonly visualStyle: string | null;
  /** 单镜头最短、最长时长（秒），null 表示不限制。 */
  readonly minShotSeconds: number | null;
  readonly maxShotSeconds: number | null;
  /** 单个镜头组的总时长上限（秒）：相邻镜头按顺序打包成一组，一组一次生成一个视频；应不超过目标视频模型的单次最长时长。 */
  readonly groupMaxSeconds: number;
  /** 镜头总数上限，null 表示使用系统上限。 */
  readonly maxShots: number | null;
  readonly continuity: ContinuityStrategy;
  readonly audioMode: AudioMode;
  /** 需要生成的声音类型；声音模式为无声时为空。 */
  readonly audioElements: readonly SoundKind[];
  readonly extra: string | null;
}

/** 一条镜头声音。 */
export interface SoundDraft {
  readonly kind: SoundKind;
  /** 说话人实体，仅角色对白使用。 */
  readonly speakerEntityId: number | null;
  readonly text: string;
  readonly delivery: string;
  readonly startOffsetSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly isEnabled: boolean;
}

/** 一个镜头的内容（不含标识）。 */
export interface ShotDraft {
  readonly seq: number;
  readonly sceneLabel: string;
  readonly shotSize: string;
  readonly cameraAngle: string;
  readonly action: string;
  readonly cameraMovement: string;
  readonly durationSeconds: number;
  readonly transition: string;
  readonly continuityNote: string;
  readonly firstFrameMode: FirstFrameMode;
  /** 首帧来源为指定资产图时的资产标识（取该资产的第一张参考图）；其他来源为 null，资产被删除后也为 null。 */
  readonly firstFrameAssetId: number | null;
  /** 出场实体标识，已去重；对白的说话人一定在其中。 */
  readonly entityIds: readonly number[];
  readonly sounds: readonly SoundDraft[];
  readonly promptZh: string;
  readonly promptEn: string;
}

/** 已保存的声音条目。 */
export interface SoundRecord extends SoundDraft {
  readonly id: number;
}

/** 已保存的镜头。 */
export interface ShotRecord extends Omit<ShotDraft, 'sounds'> {
  readonly id: number;
  readonly sounds: readonly SoundRecord[];
}

/** 一条阶段记录对应的分镜脚本。 */
export interface StoryboardScript {
  readonly id: number;
  readonly runId: number;
  readonly episodeId: number;
}

/** 用户编辑一个镜头后提交的内容：镜头序号不能修改，声音整体替换。 */
export type ShotEdit = Omit<ShotDraft, 'seq'>;

/** 镜头组：序号相邻的若干镜头，作为一次视频生成的单位。 */
export interface ShotGroup {
  readonly id: number;
  readonly seq: number;
  /** 组内镜头标识，按镜头序号升序。 */
  readonly shotIds: readonly number[];
}

/** 分组布局中的一组：groupId 为 null 表示新建的组；布局中没有出现的已有组会被删除。 */
export interface GroupLayoutEntry {
  readonly groupId: number | null;
  readonly shotIds: readonly number[];
}

/** 生成分镜脚本时可供镜头引用的实体。 */
export interface StoryboardEntity {
  readonly id: number;
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases: readonly string[];
}
