// ------------------------------------------------------------------------
// 名称：backup-service.test.ts
// 说明：数据备份应用服务的自动化测试：展示概览、备份到所选文件、选择并校验备份文件、版本过高拒绝、确认恢复准备待恢复、取消恢复、重新加载窗口。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：存储用临时目录里的真实数据库文件，宿主能力用假实现；不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ValidationError } from '../../domain/errors';
import { applyPendingRestore } from '../../infra/database/database-restore';
import { MIGRATIONS } from '../../infra/database/migrations';
import { BackupFixture, createBackupFixture, listProjectNames } from '../../infra/database/testing/backup-fixture';
import { BackupHost, BackupService } from './backup-service';

const LATEST_VERSION = MIGRATIONS.length;
const NOW = new Date(2026, 9, 3, 6, 5, 2);

/** 记录宿主调用、按预设返回对话框选择的假宿主。 */
class FakeBackupHost implements BackupHost {
  suggestedNames: string[] = [];
  reloadCount = 0;
  backupTarget: string | undefined;
  restoreSource: string | undefined;
  pickBackupTarget = async (suggestedName: string): Promise<string | undefined> => {
    this.suggestedNames.push(suggestedName);
    return this.backupTarget;
  };
  pickRestoreSource = async (): Promise<string | undefined> => this.restoreSource;
  reloadWindow = async (): Promise<void> => {
    this.reloadCount += 1;
  };
}

function createService(fixture: BackupFixture) {
  const host = new FakeBackupHost();
  const service = new BackupService({ storage: fixture.storage, host, latestSchemaVersion: LATEST_VERSION, now: () => NOW });
  return { host, service };
}

/** 断言调用抛出校验错误，返回错误提示。 */
async function expectValidationMessage(action: () => unknown): Promise<string> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof ValidationError, '应抛出校验错误');
    return error.message;
  }
  assert.fail('应抛出校验错误');
}

/** 创建一个结构版本高于当前扩展的备份文件。 */
function createFutureBackup(fixture: BackupFixture): string {
  const filePath = fixture.createBackupFile('future.sqlite', ['未来项目']);
  const file = new DatabaseSync(filePath);
  file.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
  file.close();
  return filePath;
}

test('概览：数据库状态、支持的最高版本，没有待恢复时为 null', () => {
  const fixture = createBackupFixture();
  try {
    const overview = createService(fixture).service.getOverview();
    assert.equal(overview.database.databasePath, fixture.paths.databasePath);
    assert.equal(overview.database.counts.projects, 1);
    assert.equal(overview.latestSchemaVersion, LATEST_VERSION);
    assert.equal(overview.pendingRestore, null);
  } finally {
    fixture.cleanup();
  }
});

test('备份：用带时间戳的默认文件名询问位置，导出一致的快照并返回大小', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.backupTarget = join(fixture.directory, 'my-backup.sqlite');
    const result = await service.backup();

    assert.deepEqual(host.suggestedNames, ['aigc-video-studio-backup-20261003-060502.sqlite']);
    assert.ok(!result.cancelled && result.filePath === host.backupTarget && result.sizeBytes > 0);
    const snapshot = new DatabaseSync(host.backupTarget, { readOnly: true });
    try {
      assert.deepEqual(listProjectNames(snapshot), ['当前项目']);
    } finally {
      snapshot.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('备份：用户取消时不写文件；目标是当前数据库文件时拒绝', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    assert.deepEqual(await service.backup(), { cancelled: true });

    host.backupTarget = fixture.paths.databasePath;
    const message = await expectValidationMessage(() => service.backup());
    assert.match(message, /当前正在使用的数据库文件/);
    assert.deepEqual(listProjectNames(fixture.database), ['当前项目']);
  } finally {
    fixture.cleanup();
  }
});

test('选择备份文件：用户取消时返回 cancelled，通过校验时返回文件信息', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    assert.deepEqual(await service.chooseRestoreFile(), { cancelled: true });

    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const choice = await service.chooseRestoreFile();
    assert.ok(!choice.cancelled);
    assert.equal(choice.candidate.filePath, host.restoreSource);
    assert.equal(choice.candidate.schemaVersion, LATEST_VERSION);
    assert.equal(choice.candidate.latestSchemaVersion, LATEST_VERSION);
    assert.ok(choice.candidate.sizeBytes > 0);
  } finally {
    fixture.cleanup();
  }
});

test('选择备份文件：版本高于当前扩展时拒绝，并且不能确认恢复', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = createFutureBackup(fixture);
    const message = await expectValidationMessage(() => service.chooseRestoreFile());
    assert.match(message, new RegExp(`${LATEST_VERSION + 1}.*${LATEST_VERSION}`));

    await expectValidationMessage(() => service.restore());
    assert.equal(fixture.storage.readPendingRestore(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test('选择备份文件：不是数据库、不是本扩展的数据库、就是当前数据库时都拒绝', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);

    host.restoreSource = join(fixture.directory, 'notes.txt');
    writeFileSync(host.restoreSource, '这不是数据库，只是一段足够长的普通文字。'.repeat(50));
    assert.match(await expectValidationMessage(() => service.chooseRestoreFile()), /无法作为数据库读取/);

    host.restoreSource = join(fixture.directory, 'foreign.sqlite');
    const foreign = new DatabaseSync(host.restoreSource);
    foreign.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY); PRAGMA user_version = 1');
    foreign.close();
    assert.match(await expectValidationMessage(() => service.chooseRestoreFile()), /不是本扩展的数据库备份/);

    host.restoreSource = fixture.paths.databasePath;
    assert.match(await expectValidationMessage(() => service.chooseRestoreFile()), /当前正在使用的数据库文件/);
  } finally {
    fixture.cleanup();
  }
});

test('确认恢复：准备待恢复，当前数据库不变；重新加载后先自动备份再替换', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    await service.chooseRestoreFile();

    const pending = service.restore();
    assert.ok(pending.sizeBytes > 0);
    assert.deepEqual(listProjectNames(fixture.database), ['当前项目']);
    assert.deepEqual(service.getOverview().pendingRestore, pending);

    // 模拟重新加载窗口：关闭当前连接后，下次启动先应用待恢复。
    fixture.database.close();
    const autoBackupPath = applyPendingRestore(fixture.paths, NOW);
    assert.ok(autoBackupPath !== undefined && existsSync(autoBackupPath));
    const restored = new DatabaseSync(fixture.paths.databasePath, { readOnly: true });
    try {
      assert.deepEqual(listProjectNames(restored), ['备份项目']);
    } finally {
      restored.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('确认恢复：没有选择过备份文件时拒绝；确认一次后选择即失效', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    assert.match(await expectValidationMessage(() => service.restore()), /请先选择/);

    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    await service.chooseRestoreFile();
    service.restore();
    assert.match(await expectValidationMessage(() => service.restore()), /请先选择/);
  } finally {
    fixture.cleanup();
  }
});

test('确认恢复：选择之后备份文件被改坏，确认时重新校验并拒绝', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    await service.chooseRestoreFile();
    writeFileSync(host.restoreSource, '被改坏的内容，已经不是数据库。'.repeat(50));

    await expectValidationMessage(() => service.restore());
    assert.equal(fixture.storage.readPendingRestore(), undefined);
  } finally {
    fixture.cleanup();
  }
});

test('取消恢复与重新加载窗口', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    await service.chooseRestoreFile();
    service.restore();

    service.cancelRestore();
    assert.equal(service.getOverview().pendingRestore, null);
    assert.equal(existsSync(fixture.paths.pendingRestorePath), false);

    await service.reloadWindow();
    assert.equal(host.reloadCount, 1);
  } finally {
    fixture.cleanup();
  }
});
