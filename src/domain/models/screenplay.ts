// ------------------------------------------------------------------------
// 名称：screenplay.ts
// 说明：剧本阶段的领域模型：生成参数、剧本包、从正文抽取的集与实体，以及已合并到作品的集与实体记录。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 screenplays、episodes、script_entities 表；实体的设定字段按类型区分，见 docs/database-design.md 4.5。
// ------------------------------------------------------------------------

/** 脚本实体的类型：角色、场景、道具、特效。 */
export type EntityKind = 'character' | 'scene' | 'prop' | 'effect';

/** 实体类型的界面名称。 */
export const ENTITY_KIND_LABELS: Readonly<Record<EntityKind, string>> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  effect: '特效'
};

/** 各类型实体可以有的设定字段：键与界面名称。 */
export const ENTITY_ATTRIBUTES: Readonly<Record<EntityKind, ReadonlyArray<{ readonly key: string; readonly label: string }>>> = {
  character: [
    { key: 'identity', label: '身份与目标' },
    { key: 'relations', label: '主要关系' },
    { key: 'appearance', label: '稳定外观' },
    { key: 'outfit', label: '服装或状态' },
    { key: 'voice', label: '音色设定' }
  ],
  scene: [
    { key: 'interior_exterior', label: '内外景' },
    { key: 'layout', label: '布局与出入口' },
    { key: 'fixtures', label: '固定陈设' },
    { key: 'time_light', label: '时间与光线' }
  ],
  prop: [
    { key: 'appearance', label: '外观' },
    { key: 'usage', label: '用途' },
    { key: 'states', label: '初始与变化状态' }
  ],
  effect: [
    { key: 'trigger', label: '来源或触发条件' },
    { key: 'appearance', label: '视觉表现' },
    { key: 'targets', label: '影响对象' },
    { key: 'changes', label: '变化过程' }
  ]
};

/** 剧本阶段的生成参数，已经过规范化。 */
export interface ScreenplayParams {
  /** 单集最大时长（秒），是上限，实际时长按内容决定。 */
  readonly maxEpisodeDurationSeconds: number;
  /** 集数上限；单个短视频固定为 1。 */
  readonly maxEpisodes: number;
  readonly extra: string | null;
}

/** 剧本包正文及其标题、梗概。 */
export interface ScreenplayText {
  readonly title: string;
  /** 作品信息与改编梗概。 */
  readonly overview: string;
  readonly fullText: string;
}

/** 从剧本正文抽取（或已合并）的一集。 */
export interface EpisodeDraft {
  readonly seq: number;
  readonly title: string;
  readonly synopsis: string;
  readonly screenplayText: string;
  readonly targetDurationSeconds: number | null;
}

/** 从剧本正文抽取（或已合并）的一个实体。 */
export interface EntityDraft {
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** 设定字段，键取自 ENTITY_ATTRIBUTES，值为非空文本。 */
  readonly attributes: Readonly<Record<string, string>>;
  readonly isActive: boolean;
}

/** 抽取结果：确认采用前只存在于剧本包上，确认时才合并到集和实体。 */
export interface ScreenplayStructure {
  readonly episodes: readonly EpisodeDraft[];
  readonly entities: readonly EntityDraft[];
}

/** 一条阶段记录对应的剧本包；structure 为空表示还没有抽取。 */
export interface Screenplay extends ScreenplayText {
  readonly runId: number;
  readonly structure: ScreenplayStructure | null;
  readonly updatedAt: string;
}

/** 已保存到作品的集。 */
export interface EpisodeRecord extends EpisodeDraft {
  readonly id: number;
}

/** 已保存到作品的实体。 */
export interface EntityRecord extends EntityDraft {
  readonly id: number;
}

/** 用户编辑一集后提交的内容。 */
export interface EpisodeEdit {
  readonly title: string;
  readonly synopsis: string;
  readonly screenplayText: string;
  readonly targetDurationSeconds: number | null;
}

/** 用户编辑一个实体后提交的内容；类型不能修改。 */
export interface EntityEdit {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly isActive: boolean;
}

/** 确认采用剧本时会从作品中移除的旧集：新版本的抽取结果里已不存在这一集。 */
export interface RemovedEpisode {
  readonly id: number;
  readonly seq: number;
  /** 是否已有下游数据（分镜脚本等阶段记录、资产绑定、集的生成参数）；有则不能移除，合并会被拒绝。 */
  readonly hasDownstream: boolean;
}
