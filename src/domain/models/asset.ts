// ------------------------------------------------------------------------
// 名称：asset.ts
// 说明：资产的领域模型：资产类型、按类型区分的描述字段、资产与资产文件记录、列表项与使用情况。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 assets、asset_files 表；描述字段在库里以 snake_case 键保存（见 docs/database-design.md 4.5），表单使用 camelCase 键。
// ------------------------------------------------------------------------

/** 资产类型：角色、场景、道具、特效、音频。 */
export type AssetKind = 'character' | 'scene' | 'prop' | 'effect' | 'audio';

/** 全部资产类型，按侧栏顺序。 */
export const ASSET_KINDS: readonly AssetKind[] = ['character', 'scene', 'prop', 'effect', 'audio'];

/** 资产类型的界面名称。 */
export const ASSET_KIND_LABELS: Readonly<Record<AssetKind, string>> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  effect: '特效',
  audio: '音频'
};

/** 音频资产的类型：音色参考、背景音乐、音效。 */
export type AudioKind = 'voice' | 'music' | 'sfx';

/** 音频类型的界面名称。 */
export const AUDIO_KIND_LABELS: Readonly<Record<AudioKind, string>> = {
  voice: '音色参考',
  music: '背景音乐',
  sfx: '音效'
};

/** 资产的一个描述字段：库里的键、表单键与界面名称。 */
export interface AssetAttributeField {
  readonly key: string;
  readonly formKey: string;
  readonly label: string;
}

/** 各类型资产的描述字段；音频的 audio_kind 与 language 由专门的规则处理，不在此列。 */
export const ASSET_ATTRIBUTE_FIELDS: Readonly<Record<AssetKind, readonly AssetAttributeField[]>> = {
  character: [
    { key: 'character_type', formKey: 'characterType', label: '角色类型' },
    { key: 'appearance', formKey: 'appearance', label: '角色外观' },
    { key: 'clothing', formKey: 'clothing', label: '装束' },
    { key: 'expression_pose', formKey: 'expressionPose', label: '神态与姿态' },
    { key: 'voice_description', formKey: 'voiceDescription', label: '音色描述' }
  ],
  scene: [
    { key: 'place_type', formKey: 'placeType', label: '地点类型' },
    { key: 'layout', formKey: 'layout', label: '空间布局' },
    { key: 'environment', formKey: 'environment', label: '环境与光线' }
  ],
  prop: [
    { key: 'appearance', formKey: 'appearance', label: '外观特征' },
    { key: 'state', formKey: 'state', label: '当前状态' }
  ],
  effect: [
    { key: 'source', formKey: 'source', label: '特效来源' },
    { key: 'appearance', formKey: 'appearance', label: '视觉表现' },
    { key: 'motion', formKey: 'motion', label: '触发与变化' },
    { key: 'environment_interaction', formKey: 'environmentInteraction', label: '环境交互' }
  ],
  audio: [{ key: 'description', formKey: 'description', label: '描述' }]
};

/** 资产记录中可由用户编辑的内容。 */
export interface AssetContent {
  readonly name: string;
  /** 按类型区分的描述字段，值为非空文本；音频还含 audio_kind、language。 */
  readonly attributes: Readonly<Record<string, string>>;
  readonly composition: string;
  /** 画面风格；null 表示沿用项目风格。 */
  readonly style: string | null;
  readonly background: string;
  readonly referenceAspectRatio: string | null;
  readonly extraRequirements: string;
  readonly promptZh: string;
  readonly promptEn: string;
}

/** 新建资产需要的内容：所属项目、类型与来源实体加上可编辑内容。 */
export interface AssetInput extends AssetContent {
  readonly projectId: number;
  readonly kind: AssetKind;
  /** 由哪个脚本实体创建；手动创建为 null。 */
  readonly sourceEntityId: number | null;
}

/** 已保存的资产。 */
export interface AssetRecord extends AssetInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 资产文件的用途：参考图（音频资产为参考音频）、缩略图。 */
export type AssetFileRole = 'reference' | 'thumbnail';

/** 要写入的资产文件。 */
export interface NewAssetFile {
  readonly role: AssetFileRole;
  readonly fileName: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  /** 音频时长（秒），图片为 null。 */
  readonly durationSeconds: number | null;
  readonly content: Buffer;
  readonly sortOrder: number;
}

/** 已保存的资产文件（含内容）。 */
export interface AssetFileRecord extends NewAssetFile {
  readonly id: number;
  readonly assetId: number;
}

/** 列表中的缩略图：MIME 与 Base64 内容。 */
export interface AssetThumbnail {
  readonly mime: string;
  readonly data: string;
}

/** 列表中的一个资产：不含文件内容，只带缩略图与统计。 */
export interface AssetListItem extends AssetRecord {
  readonly thumbnail: AssetThumbnail | null;
  /** 参考文件数（参考图或参考音频）。 */
  readonly fileCount: number;
  /** 参考音频时长（秒）；图片资产为 null。 */
  readonly durationSeconds: number | null;
  /** 被多少集绑定使用。 */
  readonly episodeCount: number;
}

/** 资产被使用的一处：某作品某集中绑定到某个实体。 */
export interface AssetUsage {
  readonly workName: string;
  readonly episodeSeq: number;
  readonly episodeTitle: string;
  readonly entityName: string;
}

/** 删除资产前需要告知用户的使用情况。 */
export interface AssetUsageSummary {
  /** 绑定记录（集内实体绑定）。 */
  readonly bindings: readonly AssetUsage[];
  /** 被镜头声音条目指定为音频的次数。 */
  readonly soundReferences: number;
}
