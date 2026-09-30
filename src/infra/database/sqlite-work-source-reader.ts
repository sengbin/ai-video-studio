// ------------------------------------------------------------------------
// 名称：sqlite-work-source-reader.ts
// 说明：作品素材读取的 SQLite 实现：读取小说原文与灵感图片，供创意阶段使用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：素材内容按二进制保存，小说原文按 UTF-8 解码；图片按 sort_order 排序，影响“按上传顺序”的处理。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { CreativeSourceReader } from '../../domain/ports/creative-source-reader';
import { ImageInput } from '../../domain/ports/text-generation-port';

/** work_sources 表中读取内容所需的列。 */
interface SourceRow {
  readonly mime: string;
  readonly content: Uint8Array;
}

/** 基于 SQLite 的作品素材读取器。 */
export class SqliteWorkSourceReader implements CreativeSourceReader {
  constructor(private readonly database: DatabaseSync) {}

  readNovelText(workId: number): string | undefined {
    const row = this.database
      .prepare("SELECT mime, content FROM work_sources WHERE work_id = ? AND kind = 'novel_text' ORDER BY sort_order, id LIMIT 1")
      .get(workId) as unknown as SourceRow | undefined;
    return row === undefined ? undefined : Buffer.from(row.content).toString('utf8');
  }

  readImages(workId: number): ImageInput[] {
    const rows = this.database
      .prepare("SELECT mime, content FROM work_sources WHERE work_id = ? AND kind = 'image' ORDER BY sort_order, id")
      .all(workId) as unknown as SourceRow[];
    return rows.map((row) => ({ mimeType: row.mime, data: new Uint8Array(row.content) }));
  }
}
