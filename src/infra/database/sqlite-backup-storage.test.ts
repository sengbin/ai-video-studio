// ------------------------------------------------------------------------
// 名称：sqlite-backup-storage.test.ts
// 说明：数据库备份存储与启动时恢复的自动化测试：读取状态、一致快照、只读检查备份文件、准备待恢复、应用恢复前自动备份、低版本升级、失败时保持原库。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用临时目录里的真实数据库文件；应用恢复前先关闭当前连接，与扩展“重新加载窗口后启动”的顺序一致。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BACKUP_REQUIRED_TABLES, INTEGRITY_OK } from '../../domain/rules/backup-rules';
import { openDatabase } from './database-connection';
import { applyPendingRestore } from './database-restore';
import { readSchemaVersion } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { createBackupFixture, insertProject, listProjectNames } from './testing/backup-fixture';

const RESTORE_TIME = new Date(2026, 9, 3, 6, 5, 2);
const AUTO_BACKUP_FILE_NAME = 'before-restore-20261003-060502.sqlite';

/** 以只读方式打开文件读出全部项目名。 */
function readProjectNamesFrom(filePath: string): string[] {
  const file = new DatabaseSync(filePath, { readOnly: true });
  try {
    return listProjectNames(file);
  } finally {
    file.close();
  }
}

test('读取状态：路径、大小、结构版本和各类数据数量', () => {
  const fixture = createBackupFixture();
  try {
    const status = fixture.storage.readStatus();
    assert.equal(status.databasePath, fixture.paths.databasePath);
    assert.ok(status.sizeBytes > 0);
    assert.equal(status.schemaVersion, MIGRATIONS.length);
    assert.deepEqual(status.counts, { projects: 1, works: 0, episodes: 0, assets: 0, shots: 0, videoResults: 0 });
    assert.equal(status.autoBackupDirectory, fixture.paths.autoBackupDirectory);
  } finally {
    fixture.cleanup();
  }
});

test('导出快照：内容与版本一致，之后的改动不影响快照，已有目标被替换且不留临时文件', () => {
  const fixture = createBackupFixture();
  try {
    const target = join(fixture.directory, 'snapshot.sqlite');
    writeFileSync(target, '旧内容');
    const size = fixture.storage.exportSnapshot(target);
    insertProject(fixture.database, '导出之后的项目');

    assert.ok(size > 0);
    assert.deepEqual(readProjectNamesFrom(target), ['当前项目']);
    const inspection = fixture.storage.inspectFile(target);
    assert.equal(inspection.schemaVersion, MIGRATIONS.length);
    assert.equal(inspection.integrity, INTEGRITY_OK);
    assert.ok(BACKUP_REQUIRED_TABLES.every((table) => inspection.tableNames.includes(table)));
    assert.equal(existsSync(`${target}.partial`), false);
  } finally {
    fixture.cleanup();
  }
});

test('导出快照失败：抛出错误，不留下目标文件和临时文件', () => {
  const fixture = createBackupFixture();
  try {
    const target = join(fixture.directory, '不存在的目录', 'snapshot.sqlite');
    assert.throws(() => fixture.storage.exportSnapshot(target));
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(`${target}.partial`), false);
  } finally {
    fixture.cleanup();
  }
});

test('检查文件：不是 SQLite 数据库时抛出错误，其他数据库能读出表名与版本', () => {
  const fixture = createBackupFixture();
  try {
    const notDatabase = join(fixture.directory, 'notes.txt');
    writeFileSync(notDatabase, '这不是数据库，只是一段足够长的普通文字。'.repeat(50));
    assert.throws(() => fixture.storage.inspectFile(notDatabase));

    const foreign = join(fixture.directory, 'foreign.sqlite');
    const foreignDatabase = new DatabaseSync(foreign);
    foreignDatabase.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY); PRAGMA user_version = 3');
    foreignDatabase.close();
    const inspection = fixture.storage.inspectFile(foreign);
    assert.deepEqual([...inspection.tableNames], ['notes']);
    assert.equal(inspection.schemaVersion, 3);
  } finally {
    fixture.cleanup();
  }
});

test('检查文件：只读打开，不改动所选文件', () => {
  const fixture = createBackupFixture();
  try {
    const backup = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const before = readFileSync(backup);
    fixture.storage.inspectFile(backup);
    assert.ok(readFileSync(backup).equals(before));
  } finally {
    fixture.cleanup();
  }
});

test('准备恢复：生成独立快照并标记待恢复，可读取与放弃，不改动当前数据库', () => {
  const fixture = createBackupFixture();
  try {
    assert.equal(fixture.storage.readPendingRestore(), undefined);
    const backup = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    fixture.storage.stageRestore(backup);

    const pending = fixture.storage.readPendingRestore();
    assert.ok(pending !== undefined && pending.sizeBytes > 0);
    assert.deepEqual(readProjectNamesFrom(fixture.paths.pendingRestorePath), ['备份项目']);
    assert.deepEqual(listProjectNames(fixture.database), ['当前项目']);

    fixture.storage.discardPendingRestore();
    assert.equal(fixture.storage.readPendingRestore(), undefined);
    fixture.storage.discardPendingRestore();
  } finally {
    fixture.cleanup();
  }
});

test('应用恢复：没有待恢复文件时什么也不做', () => {
  const fixture = createBackupFixture();
  try {
    fixture.database.close();
    assert.equal(applyPendingRestore(fixture.paths, RESTORE_TIME), undefined);
    assert.equal(existsSync(fixture.paths.autoBackupDirectory), false);
    assert.deepEqual(readProjectNamesFrom(fixture.paths.databasePath), ['当前项目']);
  } finally {
    fixture.cleanup();
  }
});

test('应用恢复：先把当前数据库备份到带时间戳的文件，再替换为备份内容', () => {
  const fixture = createBackupFixture();
  try {
    fixture.storage.stageRestore(fixture.createBackupFile('backup.sqlite', ['备份项目甲', '备份项目乙']));
    fixture.database.close();

    const autoBackupPath = applyPendingRestore(fixture.paths, RESTORE_TIME);

    assert.equal(autoBackupPath, join(fixture.paths.autoBackupDirectory, AUTO_BACKUP_FILE_NAME));
    assert.deepEqual(readdirSync(fixture.paths.autoBackupDirectory), [AUTO_BACKUP_FILE_NAME]);
    assert.deepEqual(readProjectNamesFrom(autoBackupPath ?? ''), ['当前项目']);
    assert.deepEqual(readProjectNamesFrom(fixture.paths.databasePath), ['备份项目甲', '备份项目乙']);
    assert.equal(existsSync(fixture.paths.pendingRestorePath), false);
  } finally {
    fixture.cleanup();
  }
});

test('应用恢复：低版本备份在重新打开数据库时由迁移执行器升级', () => {
  const fixture = createBackupFixture();
  try {
    const oldBackup = join(fixture.directory, 'old.sqlite');
    const old = openDatabase(oldBackup, MIGRATIONS.slice(0, 3));
    insertProject(old, '旧版本项目');
    old.close();
    assert.equal(fixture.storage.inspectFile(oldBackup).schemaVersion, 3);

    fixture.storage.stageRestore(oldBackup);
    fixture.database.close();
    applyPendingRestore(fixture.paths, RESTORE_TIME);

    const reopened = openDatabase(fixture.paths.databasePath);
    try {
      assert.equal(readSchemaVersion(reopened), MIGRATIONS.length);
      assert.deepEqual(listProjectNames(reopened), ['旧版本项目']);
    } finally {
      reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('应用恢复失败：抛出错误、丢弃待恢复文件，当前数据库保持不变', () => {
  const fixture = createBackupFixture();
  try {
    fixture.storage.stageRestore(fixture.createBackupFile('backup.sqlite', ['备份项目']));
    fixture.database.close();
    // 自动备份目录的位置被一个普通文件占用，创建目录会失败。
    writeFileSync(fixture.paths.autoBackupDirectory, '占位');

    assert.throws(() => applyPendingRestore(fixture.paths, RESTORE_TIME));

    assert.equal(existsSync(fixture.paths.pendingRestorePath), false);
    assert.deepEqual(readProjectNamesFrom(fixture.paths.databasePath), ['当前项目']);
  } finally {
    fixture.cleanup();
  }
});
