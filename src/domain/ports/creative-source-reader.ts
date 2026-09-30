// ------------------------------------------------------------------------
// 名称：creative-source-reader.ts
// 说明：作品素材读取的端口接口：创意阶段通过它取得小说原文和灵感图片。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：素材内容较大，不放进阶段记录的输入快照，而是在生成时读取；同步调用。
// ------------------------------------------------------------------------

import { ImageInput } from './text-generation-port';

/** 读取作品已保存的素材。 */
export interface CreativeSourceReader {
  /** 读取作品的小说原文；没有时返回 undefined。 */
  readNovelText(workId: number): string | undefined;
  /** 按上传顺序读取作品的灵感图片。 */
  readImages(workId: number): ImageInput[];
}
