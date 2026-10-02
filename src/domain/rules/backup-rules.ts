// ------------------------------------------------------------------------
// 名称：backup-rules.ts
// 说明：数据备份的业务规则：判断备份文件能否用于恢复（是否本扩展的数据库、版本是否过高、是否完好）与备份文件名的时间戳格式。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数，不读写文件；版本低于当前版本的备份由迁移执行器在重新打开数据库时升级。
// ------------------------------------------------------------------------

import { BackupFileInspection } from '../models/backup';

/** 本扩展数据库一定包含的核心表：迁移 001 创建且之后始终存在，用来识别备份文件是否本扩展的数据库。 */
export const BACKUP_REQUIRED_TABLES: readonly string[] = ['projects', 'works', 'episodes', 'stage_runs'];

/** 完整性检查通过时 PRAGMA quick_check 返回的结果。 */
export const INTEGRITY_OK = 'ok';

/**
 * 找出备份文件不能用于恢复的原因。
 * @param inspection 备份文件的检查结果。
 * @param latestSchemaVersion 当前扩展支持的最高结构版本。
 * @returns 面向用户的原因说明；文件可以用于恢复时返回 undefined。
 */
export function findBackupFileProblem(inspection: BackupFileInspection, latestSchemaVersion: number): string | undefined {
  // 先判断是否本扩展的数据库：缺核心表或没有结构版本号的文件不是本扩展创建的。
  const missingTables = BACKUP_REQUIRED_TABLES.filter((table) => !inspection.tableNames.includes(table));
  if (inspection.schemaVersion < 1 || missingTables.length > 0) {
    return '所选文件不是本扩展的数据库备份（缺少核心数据表或结构版本号）。';
  }
  // 版本高于当前程序支持的版本时无法升级或降级，必须拒绝。
  if (inspection.schemaVersion > latestSchemaVersion) {
    return `备份文件的数据库结构版本为 ${inspection.schemaVersion}，高于当前扩展支持的版本 ${latestSchemaVersion}，请先升级扩展后再恢复。`;
  }
  if (inspection.integrity !== INTEGRITY_OK) {
    return `备份文件已损坏，完整性检查未通过：${inspection.integrity}`;
  }
  return undefined;
}

/**
 * 把时间格式化为适合放进文件名的本地时间戳。
 * @param date 要格式化的时间。
 * @returns 形如 20261003-065052 的字符串（年月日-时分秒）。
 */
export function formatBackupTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}`;
}
