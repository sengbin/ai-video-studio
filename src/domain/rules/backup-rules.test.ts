// ------------------------------------------------------------------------
// 名称：backup-rules.test.ts
// 说明：数据备份业务规则的自动化测试：备份文件能否用于恢复的判断与时间戳格式。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 Node 内置测试运行器，纯函数测试，不依赖文件与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackupFileInspection } from '../models/backup';
import { BACKUP_REQUIRED_TABLES, INTEGRITY_OK, findBackupFileProblem, formatBackupTimestamp } from './backup-rules';

const LATEST_VERSION = 11;

/** 一份合法的检查结果，各用例在此基础上改动单项。 */
function inspection(overrides: Partial<BackupFileInspection> = {}): BackupFileInspection {
  return { sizeBytes: 4096, schemaVersion: LATEST_VERSION, tableNames: [...BACKUP_REQUIRED_TABLES, 'assets'], integrity: INTEGRITY_OK, ...overrides };
}

test('当前版本、完好且含核心表的备份可以恢复', () => {
  assert.equal(findBackupFileProblem(inspection(), LATEST_VERSION), undefined);
});

test('低版本备份可以恢复，由迁移执行器在重新打开时升级', () => {
  assert.equal(findBackupFileProblem(inspection({ schemaVersion: 3 }), LATEST_VERSION), undefined);
});

test('版本高于当前扩展：拒绝并说明两个版本号', () => {
  const problem = findBackupFileProblem(inspection({ schemaVersion: LATEST_VERSION + 1 }), LATEST_VERSION);
  assert.ok(problem?.includes(String(LATEST_VERSION + 1)) && problem.includes(String(LATEST_VERSION)));
  assert.ok(problem?.includes('升级扩展'));
});

test('缺少核心表或没有结构版本号：判定为不是本扩展的备份', () => {
  assert.match(findBackupFileProblem(inspection({ tableNames: ['projects', 'works'] }), LATEST_VERSION) ?? '', /不是本扩展的数据库备份/);
  assert.match(findBackupFileProblem(inspection({ schemaVersion: 0 }), LATEST_VERSION) ?? '', /不是本扩展的数据库备份/);
});

test('完整性检查未通过：拒绝并带上原因', () => {
  const problem = findBackupFileProblem(inspection({ integrity: 'page 3 is never used' }), LATEST_VERSION);
  assert.match(problem ?? '', /已损坏.*page 3 is never used/);
});

test('不是本扩展的数据库时，优先于版本过高提示', () => {
  const problem = findBackupFileProblem(inspection({ tableNames: [], schemaVersion: LATEST_VERSION + 5 }), LATEST_VERSION);
  assert.match(problem ?? '', /不是本扩展的数据库备份/);
});

test('备份时间戳按本地时间格式化为 年月日-时分秒', () => {
  assert.equal(formatBackupTimestamp(new Date(2026, 9, 3, 6, 5, 2)), '20261003-060502');
});
