// ------------------------------------------------------------------------
// 名称：memory-asset-file-store.ts
// 说明：测试用的内存资产文件存储，路径由内容哈希决定，与本地实现的行为一致。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除。
// ------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { AssetFileStore } from '../asset-file-store';

/** 保存在内存中的资产文件存储。 */
export class MemoryAssetFileStore implements AssetFileStore {
  /** 当前保存的全部文件，键为相对路径，便于测试检查。 */
  readonly files = new Map<string, Buffer>();

  write(content: Buffer, mime: string): string {
    const filePath = `${createHash('sha256').update(content).digest('hex')}.${mime.split('/')[1]}`;
    this.files.set(filePath, Buffer.from(content));
    return filePath;
  }

  read(filePath: string): Buffer {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`文件不存在：${filePath}`);
    }
    return Buffer.from(content);
  }

  remove(filePath: string): void {
    this.files.delete(filePath);
  }
}
