// ------------------------------------------------------------------------
// 名称：backup-service.test.ts
// 说明：数据备份应用服务的自动化测试：展示概览、备份到所选文件、选择并校验备份文件、版本过高拒绝、确认恢复准备待恢复、确认与取消恢复的标识校验、取消恢复、重新加载窗口、数据库无法打开时的降级模式。
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
import { SqliteBackupStorage } from '../../infra/database/sqlite-backup-storage';
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

/** 选择备份文件并断言通过校验，返回本次选择的标识。 */
async function chooseToken(service: BackupService): Promise<string> {
  const choice = await service.chooseRestoreFile();
  assert.ok(!choice.cancelled, '应选中备份文件');
  return choice.candidate.token;
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
    assert.equal(overview.database?.databasePath, fixture.paths.databasePath);
    assert.equal(overview.database?.counts.projects, 1);
    assert.equal(overview.databaseUnavailableReason, null);
    assert.equal(overview.autoBackupDirectory, fixture.paths.autoBackupDirectory);
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
    assert.ok(choice.candidate.token !== '', '选择带有标识');
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

    await expectValidationMessage(() => service.restore('任意标识'));
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
    const token = await chooseToken(service);

    const pending = service.restore(token);
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
    assert.match(await expectValidationMessage(() => service.restore('任意标识')), /请先选择/);

    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const token = await chooseToken(service);
    service.restore(token);
    assert.match(await expectValidationMessage(() => service.restore(token)), /请先选择/);
  } finally {
    fixture.cleanup();
  }
});

test('确认恢复：选择之后备份文件被改坏，确认时重新校验并拒绝', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const token = await chooseToken(service);
    writeFileSync(host.restoreSource, '被改坏的内容，已经不是数据库。'.repeat(50));

    await expectValidationMessage(() => service.restore(token));
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
    const token = await chooseToken(service);
    const pending = service.restore(token);

    service.cancelRestore(pending.token);
    assert.equal(service.getOverview().pendingRestore, null);
    assert.equal(existsSync(fixture.paths.pendingRestorePath), false);

    await service.reloadWindow();
    assert.equal(host.reloadCount, 1);
  } finally {
    fixture.cleanup();
  }
});

test('确认恢复：标识与当前选择不一致时拒绝，不准备待恢复；重新选择后旧标识失效', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    host.restoreSource = fixture.createBackupFile('first.sqlite', ['第一个备份']);
    const firstToken = await chooseToken(service);
    host.restoreSource = fixture.createBackupFile('second.sqlite', ['第二个备份']);
    const secondToken = await chooseToken(service);
    assert.notEqual(firstToken, secondToken, '每次选择的标识不同');

    assert.match(await expectValidationMessage(() => service.restore(firstToken)), /不一致/);
    assert.match(await expectValidationMessage(() => service.restore('')), /不一致/);
    assert.equal(fixture.storage.readPendingRestore(), undefined);

    // 不一致的确认不会清掉当前选择，用正确的标识仍可确认，恢复的是第二个文件。
    service.restore(secondToken);
    fixture.database.close();
    applyPendingRestore(fixture.paths, NOW);
    const restored = new DatabaseSync(fixture.paths.databasePath, { readOnly: true });
    try {
      assert.deepEqual(listProjectNames(restored), ['第二个备份']);
    } finally {
      restored.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('取消恢复：没有待恢复项时拒绝；标识不一致时拒绝且保留待恢复项；标识一致才取消', async () => {
  const fixture = createBackupFixture();
  try {
    const { host, service } = createService(fixture);
    assert.match(await expectValidationMessage(() => service.cancelRestore('任意标识')), /没有待生效的恢复/);

    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const pending = service.restore(await chooseToken(service));
    assert.match(await expectValidationMessage(() => service.cancelRestore('过期的标识')), /已发生变化/);
    assert.deepEqual(service.getOverview().pendingRestore, pending, '待恢复项仍在');

    service.cancelRestore(pending.token);
    assert.equal(service.getOverview().pendingRestore, null);
  } finally {
    fixture.cleanup();
  }
});

test('降级模式：数据库无法打开时概览不读取数据库状态，不能备份，仍可选择文件、确认和取消恢复', async () => {
  const fixture = createBackupFixture();
  try {
    // 用不带连接的存储，模拟数据库无法打开。
    const storage = new SqliteBackupStorage(undefined, fixture.paths, join(fixture.directory, 'videos'), join(fixture.directory, 'asset-files'));
    const host = new FakeBackupHost();
    const service = new BackupService({ storage, host, latestSchemaVersion: LATEST_VERSION, databaseUnavailableReason: '文件已损坏' });

    const overview = service.getOverview();
    assert.equal(overview.database, null);
    assert.equal(overview.databaseUnavailableReason, '文件已损坏');
    assert.equal(overview.autoBackupDirectory, fixture.paths.autoBackupDirectory);
    assert.equal(overview.pendingRestore, null);

    host.backupTarget = join(fixture.directory, 'never.sqlite');
    assert.match(await expectValidationMessage(() => service.backup()), /不能备份/);
    assert.equal(existsSync(host.backupTarget), false);

    host.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const pending = service.restore(await chooseToken(service));
    assert.equal(service.getOverview().pendingRestore?.token, pending.token);
    service.cancelRestore(pending.token);
    assert.equal(service.getOverview().pendingRestore, null);
  } finally {
    fixture.cleanup();
  }
});