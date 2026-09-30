// ------------------------------------------------------------------------
// 名称：database-connection.test.ts
// 说明：数据库连接与迁移的自动化测试：建库、约束、级联、失败回滚和升级备份。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 Node 内置测试运行器，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { Migration, MigrationError } from './migration';
import { readSchemaVersion } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { runInTransaction } from './transaction';

const NOW = '2026-01-01T00:00:00.000Z';
const EXPECTED_TABLE_COUNT = 22;

/** 查询库中所有业务表的名称。 */
function listTableNames(database: DatabaseSync): string[] {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** 统计指定表的行数。 */
function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
  return row.total;
}

/** 插入一个项目、一个作品和一集，返回它们的标识。 */
function seedWorkWithEpisode(database: DatabaseSync): { projectId: number; workId: number; episodeId: number } {
  database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('项目甲', NOW, NOW);
  database
    .prepare('INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('作品甲', 'series', NOW, NOW);
  database
    .prepare('INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)')
    .run('第一集', NOW, NOW);
  return { projectId: 1, workId: 1, episodeId: 1 };
}

test('新库升级到最新版本并创建全部业务表', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    assert.equal(readSchemaVersion(database), MIGRATIONS.length);
    assert.equal(listTableNames(database).length, EXPECTED_TABLE_COUNT);
  } finally {
    database.close();
  }
});

test('外键已启用：删除项目级联删除作品、集和资产', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO assets (project_id, kind, name, created_at, updated_at) VALUES (1, 'character', ?, ?, ?)")
      .run('林夏', NOW, NOW);

    database.prepare('DELETE FROM projects WHERE id = 1').run();

    assert.equal(countRows(database, 'works'), 0);
    assert.equal(countRows(database, 'episodes'), 0);
    assert.equal(countRows(database, 'assets'), 0);
  } finally {
    database.close();
  }
});

test('外键生效：作品不能引用不存在的项目', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    assert.throws(() =>
      database
        .prepare('INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (99, ?, ?, ?, ?)')
        .run('孤儿', 'single', NOW, NOW)
    );
  } finally {
    database.close();
  }
});

test('同一项目内作品名称唯一', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    assert.throws(() =>
      database
        .prepare('INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
        .run('作品甲', 'single', NOW, NOW)
    );
  } finally {
    database.close();
  }
});

test('同一作品同一阶段只能有一个当前版本', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    const insertRun = database.prepare(
      "INSERT INTO stage_runs (work_id, stage, version, input_json, is_current, created_at) VALUES (1, 'creative', ?, '{}', 1, ?)"
    );
    insertRun.run(1, NOW);
    assert.throws(() => insertRun.run(2, NOW));
  } finally {
    database.close();
  }
});

test('分镜脚本阶段必须带集，其他阶段不能带集', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO stage_runs (work_id, stage, version, input_json, created_at) VALUES (1, 'storyboard_script', 1, '{}', ?)"
        )
        .run(NOW)
    );
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (1, 1, 'creative', 1, '{}', ?)"
        )
        .run(NOW)
    );
  } finally {
    database.close();
  }
});

test('JSON 列拒绝非法 JSON', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    assert.throws(() =>
      database
        .prepare(
          "INSERT INTO stage_runs (work_id, stage, version, input_json, created_at) VALUES (1, 'creative', 1, 'not json', ?)"
        )
        .run(NOW)
    );
  } finally {
    database.close();
  }
});

test('生成参数：范围与目标必须一致，且每个目标只有一条', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    const insertWorkProfile = database.prepare(
      "INSERT INTO generation_profiles (scope, work_id, updated_at) VALUES ('work', 1, ?)"
    );
    insertWorkProfile.run(NOW);

    assert.throws(() => insertWorkProfile.run(NOW), '同一作品只能有一条作品级参数');
    assert.throws(
      () =>
        database
          .prepare("INSERT INTO generation_profiles (scope, work_id, episode_id, updated_at) VALUES ('work', 1, 1, ?)")
          .run(NOW),
      '范围为作品时不能同时指定集'
    );
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO generation_profiles (scope, episode_id, min_shot_seconds, max_shot_seconds, updated_at) VALUES ('episode', 1, 8, 3, ?)"
          )
          .run(NOW),
      '最短时长不能大于最长时长'
    );
  } finally {
    database.close();
  }
});

test('每个实体在本集同一用途下只能有一个主资产', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare(
        "INSERT INTO script_entities (work_id, kind, name, created_at, updated_at) VALUES (1, 'character', ?, ?, ?)"
      )
      .run('林夏', NOW, NOW);
    const insertAsset = database.prepare(
      "INSERT INTO assets (project_id, kind, name, created_at, updated_at) VALUES (1, 'character', ?, ?, ?)"
    );
    insertAsset.run('林夏日常', NOW, NOW);
    insertAsset.run('林夏雨天', NOW, NOW);
    const insertBinding = database.prepare(
      'INSERT INTO entity_bindings (episode_id, entity_id, asset_id, created_at) VALUES (1, 1, ?, ?)'
    );
    insertBinding.run(1, NOW);
    assert.throws(() => insertBinding.run(2, NOW));
  } finally {
    database.close();
  }
});

test('删除资产文件时镜头的首帧图片引用被置空而不是拒绝删除', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO assets (project_id, kind, name, created_at, updated_at) VALUES (1, 'scene', ?, ?, ?)")
      .run('灯塔', NOW, NOW);
    database
      .prepare(
        "INSERT INTO asset_files (asset_id, mime, file_name, size_bytes, content, created_at) VALUES (1, 'image/png', 'a.png', 1, x'00', ?)"
      )
      .run(NOW);
    database
      .prepare("INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (1, 1, 'storyboard_script', 1, '{}', ?)")
      .run(NOW);
    database.prepare('INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (1, 1, ?)').run(NOW);
    database
      .prepare(
        "INSERT INTO shots (storyboard_script_id, seq, action, duration_seconds, first_frame_mode, first_frame_asset_file_id, created_at, updated_at) VALUES (1, 1, '远景', 5, 'asset', 1, ?, ?)"
      )
      .run(NOW, NOW);

    database.prepare('DELETE FROM asset_files WHERE id = 1').run();

    const shot = database.prepare('SELECT first_frame_asset_file_id AS fileId FROM shots WHERE id = 1').get() as {
      fileId: number | null;
    };
    assert.equal(shot.fileId, null);
  } finally {
    database.close();
  }
});

test('模型被生成参数引用时不能删除', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO providers (code, display_name, created_at, updated_at) VALUES ('wanxiang', '万象', ?, ?)")
      .run(NOW, NOW);
    database.prepare("INSERT INTO models (provider_id, code, display_name, created_at) VALUES (1, 'm1', '模型一', ?)").run(NOW);
    database
      .prepare("INSERT INTO generation_profiles (scope, work_id, model_id, updated_at) VALUES ('work', 1, 1, ?)")
      .run(NOW);

    assert.throws(() => database.prepare('DELETE FROM models WHERE id = 1').run());
  } finally {
    database.close();
  }
});

test('迁移执行失败时抛出迁移错误并带上原因', () => {
  const goodMigration: Migration = { version: 1, name: 'good', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' };
  const badMigration: Migration = {
    version: 2,
    name: 'bad',
    sql: 'CREATE TABLE beta (id INTEGER PRIMARY KEY); CREATE TABLE beta (id INTEGER PRIMARY KEY);'
  };

  assert.throws(
    () => openDatabase(IN_MEMORY_DATABASE_PATH, [goodMigration, badMigration]),
    (error: unknown) => error instanceof MigrationError && error.cause !== undefined
  );
});

test('迁移失败后已创建的表被回滚', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-video-studio-test-'));
  const filePath = join(directory, 'rollback.sqlite');
  const goodMigration: Migration = { version: 1, name: 'good', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' };
  const badMigration: Migration = {
    version: 2,
    name: 'bad',
    sql: 'CREATE TABLE beta (id INTEGER PRIMARY KEY); CREATE TABLE gamma (id INTEGER PRIMARY KEY); SELECT * FROM missing_table_for_test;'
  };
  try {
    openDatabase(filePath, [goodMigration]).close();
    assert.throws(() => openDatabase(filePath, [goodMigration, badMigration]));

    const database = openDatabase(filePath, [goodMigration]);
    try {
      assert.equal(readSchemaVersion(database), 1);
      assert.deepEqual(listTableNames(database), ['alpha']);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('数据库版本高于程序支持的版本时拒绝打开', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-video-studio-test-'));
  const filePath = join(directory, 'newer.sqlite');
  const migrationOne: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' };
  const migrationTwo: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE beta (id INTEGER PRIMARY KEY);' };
  try {
    openDatabase(filePath, [migrationOne, migrationTwo]).close();
    assert.throws(() => openDatabase(filePath, [migrationOne]), MigrationError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('迁移版本号必须从 1 开始连续', () => {
  const skipped: Migration = { version: 2, name: 'skipped', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' };
  assert.throws(() => openDatabase(IN_MEMORY_DATABASE_PATH, [skipped]), MigrationError);
});

test('升级已有数据的库之前先备份，新库不备份', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-video-studio-test-'));
  const filePath = join(directory, 'upgrade.sqlite');
  const migrationOne: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);' };
  const migrationTwo: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE beta (id INTEGER PRIMARY KEY);' };
  try {
    openDatabase(filePath, [migrationOne]).close();
    assert.equal(existsSync(`${filePath}.backup-v0`), false, '新库不应产生备份');

    const database = openDatabase(filePath, [migrationOne, migrationTwo]);
    database.close();

    assert.equal(existsSync(`${filePath}.backup-v1`), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('事务：成功提交，异常回滚', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    runInTransaction(database, () => {
      database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('保留', NOW, NOW);
    });
    assert.throws(() =>
      runInTransaction(database, () => {
        database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('回滚', NOW, NOW);
        throw new Error('中途失败');
      })
    );
    assert.equal(countRows(database, 'projects'), 1);
  } finally {
    database.close();
  }
});
