// ------------------------------------------------------------------------
// 名称：backup-handlers.test.ts
// 说明：数据备份页请求处理的自动化测试：通过真实的消息路由器调用，覆盖读取概览、备份、选择并校验备份文件、确认恢复、取消恢复、重新加载窗口以及错误响应。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：服务使用临时目录里的真实数据库文件和假宿主；不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../infra/database/migrations';
import { createBackupFixture } from '../../infra/database/testing/backup-fixture';
import { MessageRouter } from '../messaging/message-router';
import { BackupService } from '../services/backup-service';
import { BACKUP_REQUESTS, registerBackupHandlers } from './backup-handlers';

const LATEST_VERSION = MIGRATIONS.length;

function createRouter() {
  const fixture = createBackupFixture();
  const choices: { backupTarget?: string; restoreSource?: string; reloadCount: number } = { reloadCount: 0 };
  const service = new BackupService({
    storage: fixture.storage,
    host: {
      pickBackupTarget: async () => choices.backupTarget,
      pickRestoreSource: async () => choices.restoreSource,
      reloadWindow: async () => {
        choices.reloadCount += 1;
      }
    },
    latestSchemaVersion: LATEST_VERSION
  });
  const router = new MessageRouter();
  registerBackupHandlers(router, service);
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  /** 发送请求并断言成功，返回响应数据。 */
  const callOk = async <T>(name: string, payload?: unknown): Promise<T> => {
    const response = await send(name, payload);
    assert.ok(response?.ok, '请求应成功');
    return response.data as T;
  };
  /** 发送请求并断言失败，返回错误载荷。 */
  const callError = async (name: string, payload?: unknown) => {
    const response = await send(name, payload);
    assert.ok(response !== undefined && !response.ok, '请求应失败');
    return response.error;
  };
  return { fixture, choices, callOk, callError };
}

interface OverviewData {
  readonly database: { readonly databasePath: string; readonly schemaVersion: number; readonly counts: { readonly projects: number } };
  readonly latestSchemaVersion: number;
  readonly pendingRestore: { readonly sizeBytes: number } | null;
}

test('读取概览：返回数据库状态与支持的最高版本', async () => {
  const { fixture, callOk } = createRouter();
  try {
    const data = await callOk<OverviewData>(BACKUP_REQUESTS.load);
    assert.equal(data.database.databasePath, fixture.paths.databasePath);
    assert.equal(data.database.schemaVersion, LATEST_VERSION);
    assert.equal(data.database.counts.projects, 1);
    assert.equal(data.latestSchemaVersion, LATEST_VERSION);
    assert.equal(data.pendingRestore, null);
  } finally {
    fixture.cleanup();
  }
});

test('备份：返回文件路径与大小；用户取消返回 cancelled；目标是当前数据库时返回校验错误', async () => {
  const { fixture, choices, callOk, callError } = createRouter();
  try {
    assert.deepEqual(await callOk(BACKUP_REQUESTS.export), { cancelled: true });

    choices.backupTarget = join(fixture.directory, 'backup.sqlite');
    const result = await callOk<{ cancelled: boolean; filePath: string; sizeBytes: number }>(BACKUP_REQUESTS.export);
    assert.equal(result.cancelled, false);
    assert.equal(result.filePath, choices.backupTarget);
    assert.ok(result.sizeBytes > 0);

    choices.backupTarget = fixture.paths.databasePath;
    const error = await callError(BACKUP_REQUESTS.export);
    assert.equal(error?.kind, 'validation');
  } finally {
    fixture.cleanup();
  }
});

test('恢复流程：选择文件、确认、读到待恢复、取消恢复', async () => {
  const { fixture, choices, callOk } = createRouter();
  try {
    assert.deepEqual(await callOk(BACKUP_REQUESTS.chooseRestoreFile), { cancelled: true });

    choices.restoreSource = fixture.createBackupFile('backup.sqlite', ['备份项目']);
    const choice = await callOk<{ cancelled: boolean; candidate: { filePath: string; schemaVersion: number; latestSchemaVersion: number } }>(
      BACKUP_REQUESTS.chooseRestoreFile
    );
    assert.equal(choice.cancelled, false);
    assert.equal(choice.candidate.filePath, choices.restoreSource);
    assert.equal(choice.candidate.schemaVersion, LATEST_VERSION);

    // 确认请求不带路径，恢复哪个文件由宿主记住的选择决定。
    const restored = await callOk<{ pendingRestore: { sizeBytes: number } }>(BACKUP_REQUESTS.restore, { filePath: 'C:\\其他文件.sqlite' });
    assert.ok(restored.pendingRestore.sizeBytes > 0);
    assert.notEqual((await callOk<OverviewData>(BACKUP_REQUESTS.load)).pendingRestore, null);

    assert.deepEqual(await callOk(BACKUP_REQUESTS.cancelRestore), { cancelled: true });
    assert.equal((await callOk<OverviewData>(BACKUP_REQUESTS.load)).pendingRestore, null);
  } finally {
    fixture.cleanup();
  }
});

test('恢复：版本过高的备份文件返回校验错误并说明原因；没有选择文件就确认也返回校验错误', async () => {
  const { fixture, choices, callError } = createRouter();
  try {
    const future = fixture.createBackupFile('future.sqlite', ['未来项目']);
    const file = new DatabaseSync(future);
    file.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    file.close();
    choices.restoreSource = future;

    const error = await callError(BACKUP_REQUESTS.chooseRestoreFile);
    assert.equal(error?.kind, 'validation');
    assert.match(error?.message ?? '', /高于当前扩展支持的版本/);

    assert.equal((await callError(BACKUP_REQUESTS.restore))?.kind, 'validation');
  } finally {
    fixture.cleanup();
  }
});

test('重新加载窗口：经宿主执行', async () => {
  const { fixture, choices, callOk } = createRouter();
  try {
    assert.deepEqual(await callOk(BACKUP_REQUESTS.reloadWindow), { requested: true });
    assert.equal(choices.reloadCount, 1);
  } finally {
    fixture.cleanup();
  }
});
