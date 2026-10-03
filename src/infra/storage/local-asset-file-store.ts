// ------------------------------------------------------------------------
// 名称：local-asset-file-store.ts
// 说明：资产文件存储的本地实现：把图片、音频保存在扩展存储目录下，路径由内容的 SHA-256 决定，相同内容只保存一份。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：路径形如 `ab/ab12….png`（前两位十六进制作子目录，避免单个目录文件过多）；先写临时文件再改名，避免留下写了一半的文件；所有读写都经过 resolveInsideRoot 校验，路径不会越出根目录。
// ------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { AssetFileStore } from '../../domain/ports/asset-file-store';
import { resolveInsideRoot } from './relative-path';

/** 资产文件在存储根目录下的子目录名；数据备份页据此告知用户这些文件不在数据库备份内。 */
export const ASSET_FILE_DIRECTORY_NAME = 'asset-files';

/** 写入中的临时文件后缀。 */
const PARTIAL_SUFFIX = '.part';

/** 各文件类型的扩展名，与资产文件表允许的 MIME 一致。 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a'
};

/** 子目录取哈希的前几位。 */
const SHARD_LENGTH = 2;

/** 把资产文件保存在本地目录的存储。 */
export class LocalAssetFileStore implements AssetFileStore {
  /**
   * @param rootDirectory 资产文件根目录的绝对路径。
   */
  constructor(private readonly rootDirectory: string) {}

  write(content: Buffer, mime: string): string {
    const extension = EXTENSION_BY_MIME[mime];
    if (extension === undefined) {
      throw new Error(`不支持保存这种文件类型：${mime}。`);
    }
    const hash = createHash('sha256').update(content).digest('hex');
    const filePath = `${hash.slice(0, SHARD_LENGTH)}/${hash}${extension}`;
    const absolutePath = resolveInsideRoot(this.rootDirectory, filePath);
    // 同样内容已经保存过就直接复用，路径即内容的指纹。
    if (existsSync(absolutePath)) {
      return filePath;
    }
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const partialPath = `${absolutePath}${PARTIAL_SUFFIX}`;
    try {
      writeFileSync(partialPath, content);
      renameSync(partialPath, absolutePath);
    } catch (error) {
      rmSync(partialPath, { force: true });
      throw error;
    }
    return filePath;
  }

  read(filePath: string): Buffer {
    return readFileSync(resolveInsideRoot(this.rootDirectory, filePath));
  }

  remove(filePath: string): void {
    rmSync(resolveInsideRoot(this.rootDirectory, filePath), { force: true });
  }
}
