// ------------------------------------------------------------------------
// 名称：relative-path.ts
// 说明：本地文件存储共用的路径解析：把相对存储根目录的路径解析为绝对路径，并保证结果落在根目录之内。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：结果视频存储与资产文件存储共用；路径使用 `/` 分隔。
// ------------------------------------------------------------------------

import * as path from 'node:path';

/**
 * 把相对存储根目录的路径解析为绝对路径。
 * @param rootDirectory 存储根目录的绝对路径。
 * @param filePath 相对存储根目录、使用 `/` 分隔的路径。
 * @returns 位于存储根目录之内的绝对路径。
 * @throws Error 路径是绝对路径，或解析后不在存储根目录之内（含 `..` 越界、指向根目录本身）。
 */
export function resolveInsideRoot(rootDirectory: string, filePath: string): string {
  if (path.isAbsolute(filePath) || filePath.startsWith('/')) {
    throw new Error('文件路径必须是相对存储目录的路径，不能是绝对路径。');
  }
  const absolutePath = path.resolve(rootDirectory, ...filePath.split('/'));
  const relative = path.relative(path.resolve(rootDirectory), absolutePath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('文件路径超出了存储目录。');
  }
  return absolutePath;
}
