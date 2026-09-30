// ------------------------------------------------------------------------
// 名称：creative.ts
// 说明：创意阶段的领域模型：生成参数、章节大纲项和章节正文。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：参数对应 F3 表单中影响生成的字段，作品名称、形态、素材由作品服务处理。
// ------------------------------------------------------------------------

/** 创意阶段的生成参数，已经过规范化；可选字段为空表示不指定。 */
export interface CreativeParams {
  readonly idea: string | null;
  readonly genre: string | null;
  readonly tone: string | null;
  /** 每章最少字数。 */
  readonly chapterMinWords: number;
  /** 每章最多字数。 */
  readonly chapterMaxWords: number;
  /** 章节数上限，不是必须达到的章节数。 */
  readonly maxChapters: number;
  readonly preserve: string | null;
  readonly adjust: string | null;
  readonly extra: string | null;
}

/** 大纲中的一章：序号由顺序决定，从 1 开始。 */
export interface ChapterOutlineItem {
  readonly seq: number;
  readonly title: string;
  readonly summary: string;
}

/** 生成的一章正文。 */
export interface ChapterDraft {
  readonly seq: number;
  readonly title: string;
  readonly content: string;
}
