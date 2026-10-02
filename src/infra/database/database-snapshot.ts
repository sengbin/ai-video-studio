// ------------------------------------------------------------------------
// 名称：database-snapshot.ts
// 说明：把一个已打开的 SQLite 数据库写成独立的一致快照文件：先用 VACUUM INTO 写到临时文件，成功后再改名替换目标，不会留下写了一半的目标文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：VACUUM INTO 不能在事务中执行，且要求目标文件不存在；快照保留 user_version，源库以只读方式打开也可使用。
// ------------------------------------------------------------------------

import { renameSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** 快照写入过程中的临时文件后缀。 */
const PARTIAL_SUFFIX = '.partial';

/**
 * 把数据库的一致快照写入目标文件；目标已存在时被替换。
 * @param database 已打开的源数据库连接。
 * @param targetPath 目标文件的绝对路径。
 * @throws 写入失败时抛出错误，临时文件会被清理，已有的目标文件保持不变。
 */
export function writeSnapshot(database: DatabaseSync, targetPath: string): void {
  const partialPath = `${targetPath}${PARTIAL_SUFFIX}`;
  rmSync(partialPath, { force: true });
  try {
    // 路径中的单引号按 SQL 规则转义；路径来自受控的文件对话框或存储目录，不拼接界面输入。
    database.exec(`VACUUM INTO '${partialPath.replace(/'/g, "''")}'`);
    renameSync(partialPath, targetPath);
  } catch (error) {
    rmSync(partialPath, { force: true });
    throw error;
  }
}
