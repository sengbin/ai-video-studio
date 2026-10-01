// ------------------------------------------------------------------------
// 名称：work.ts
// 说明：作品的领域模型：作品形态、素材来源、作品记录和随作品保存的素材文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：对应 works、work_sources 表；单个短视频创建时同时创建第 1 集。
// ------------------------------------------------------------------------

/** 作品形态：单个短视频、多集短片。 */
export type WorkKind = 'single' | 'series';

/** 素材来源：文字灵感、灵感图片、小说原文。 */
export type WorkSourceType = 'text' | 'image' | 'novel';

/** 素材文件类别：图片、小说文本。 */
export type WorkSourceKind = 'image' | 'novel_text';

/** 创建作品时提交的内容，已经过规范化。 */
export interface WorkInput {
  readonly name: string;
  readonly kind: WorkKind;
  readonly sourceType: WorkSourceType;
}

/** 修改作品时提交的内容，已经过规范化；素材来源创建后不能修改。 */
export interface WorkUpdate {
  readonly name: string;
  readonly kind: WorkKind;
  /** 灵感图片作品提交的完整图片列表（按顺序，整体替换原有图片）；其他作品为空。 */
  readonly images?: readonly NewWorkSource[];
}

/** 作品。 */
export interface Work extends WorkInput {
  readonly id: number;
  readonly projectId: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 随作品保存的一个素材文件，保存顺序即上传顺序。 */
export interface NewWorkSource {
  readonly kind: WorkSourceKind;
  readonly fileName: string;
  readonly mime: string;
  readonly content: Uint8Array;
}
