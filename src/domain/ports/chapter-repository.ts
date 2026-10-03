// ------------------------------------------------------------------------
// 名称：chapter-repository.ts
// 说明：创意章节数据访问的端口接口，创意阶段逐章保存产出，中断后可从已保存的章节继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：章节属于某条阶段记录，随记录级联删除；同步调用。
// ------------------------------------------------------------------------

import { ChapterDraft } from '../models/creative';

/** 章节的数据访问接口。 */
export interface ChapterRepository {
  /** 列出阶段记录下已保存的章节，按序号升序。 */
  list(runId: number): ChapterDraft[];
  /** 保存一章；同一序号已存在时覆盖。 */
  save(runId: number, chapter: ChapterDraft, timestamp: string): void;
  /** 清除阶段记录下已保存的全部章节；用于丢弃与素材不一致的旧进度。 */
  clear(runId: number): void;
}
