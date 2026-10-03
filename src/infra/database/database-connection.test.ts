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
import { DatabaseSync } from 'node:sqlite';
import { EMPTY_PROFILE } from '../../domain/models/generation-profile';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { Migration, MigrationError } from './migration';
import { readSchemaVersion } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { SqliteGenerationProfileRepository } from './sqlite-generation-profile-repository';
import { runInTransaction } from './transaction';

const NOW = '2026-01-01T00:00:00.000Z';
const EXPECTED_TABLE_COUNT = 27;

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

test('外键已启用：删除项目级联删除作品和集，资产不属于项目、不受影响', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('character', ?, ?, ?)")
      .run('林夏', NOW, NOW);

    database.prepare('DELETE FROM projects WHERE id = 1').run();

    assert.equal(countRows(database, 'works'), 0);
    assert.equal(countRows(database, 'episodes'), 0);
    assert.equal(countRows(database, 'assets'), 1);
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
      "INSERT INTO stage_runs (work_id, stage, version, input_json, status, review_status, is_current, created_at) VALUES (1, 'creative', ?, '{}', 'succeeded', 'approved', 1, ?)"
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
      "INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('character', ?, ?, ?)"
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

test('删除资产时镜头指定的首帧资产引用被置空而不是拒绝删除', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('scene', ?, ?, ?)")
      .run('灯塔', NOW, NOW);
    database
      .prepare("INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (1, 1, 'storyboard_script', 1, '{}', ?)")
      .run(NOW);
    database.prepare('INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (1, 1, ?)').run(NOW);
    database
      .prepare(
        "INSERT INTO shots (storyboard_script_id, seq, action, duration_seconds, first_frame_mode, first_frame_asset_id, created_at, updated_at) VALUES (1, 1, '远景', 5, 'asset', 1, ?, ?)"
      )
      .run(NOW, NOW);
    assert.throws(
      () => database.prepare('UPDATE shots SET first_frame_asset_id = 99 WHERE id = 1').run(),
      '不存在的资产违反外键'
    );

    database.prepare('DELETE FROM assets WHERE id = 1').run();

    const shot = database.prepare('SELECT first_frame_mode AS mode, first_frame_asset_id AS assetId FROM shots WHERE id = 1').get() as {
      mode: string;
      assetId: number | null;
    };
    assert.deepEqual({ ...shot }, { mode: 'asset', assetId: null });
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
  const directory = mkdtempSync(join(tmpdir(), 'aigc-video-studio-test-'));
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
  const directory = mkdtempSync(join(tmpdir(), 'aigc-video-studio-test-'));
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
  const directory = mkdtempSync(join(tmpdir(), 'aigc-video-studio-test-'));
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

test('阶段记录：待确认、已确认与当前版本的约束', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    const insert = (status: string, review: string, current: number, version: number) =>
      database
        .prepare(
          "INSERT INTO stage_runs (work_id, stage, version, input_json, status, review_status, is_current, created_at) VALUES (1, 'creative', ?, '{}', ?, ?, ?, ?)"
        )
        .run(version, status, review, current, NOW);

    assert.throws(() => insert('running', 'approved', 0, 1), '未成功的记录不能是已确认');
    assert.throws(() => insert('succeeded', 'pending', 1, 1), '当前版本必须已确认');
    assert.throws(() => insert('canceled', 'approved', 0, 1));
    insert('canceled', 'pending', 0, 1);
    insert('succeeded', 'approved', 1, 2);
    assert.throws(() => insert('succeeded', 'approved', 1, 3), '同一目标只能有一个当前版本');
  } finally {
    database.close();
  }
});

test('阶段记录：同一目标同时只能有一个运行中的记录，分镜脚本按集区分', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare('INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (1, 2, ?, ?, ?)')
      .run('第二集', NOW, NOW);
    const insertCreative = database.prepare(
      "INSERT INTO stage_runs (work_id, stage, version, input_json, created_at) VALUES (1, 'creative', ?, '{}', ?)"
    );
    const insertStoryboard = database.prepare(
      "INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (1, ?, 'storyboard_script', 1, '{}', ?)"
    );

    insertCreative.run(1, NOW);
    assert.throws(() => insertCreative.run(2, NOW));
    insertStoryboard.run(1, NOW);
    insertStoryboard.run(2, NOW);
    assert.throws(() => insertStoryboard.run(1, NOW));

    database.prepare("UPDATE stage_runs SET status = 'failed' WHERE stage = 'creative'").run();
    insertCreative.run(2, NOW);
  } finally {
    database.close();
  }
});

test('阶段记录：进度必须是合法 JSON，上游记录被删除时置空', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare(
        "INSERT INTO stage_runs (work_id, stage, version, input_json, status, review_status, is_current, created_at) VALUES (1, 'creative', 1, '{}', 'succeeded', 'approved', 1, ?)"
      )
      .run(NOW);
    database
      .prepare(
        "INSERT INTO stage_runs (work_id, stage, version, input_json, source_run_id, source_revision, created_at) VALUES (1, 'screenplay', 1, '{}', 1, 1, ?)"
      )
      .run(NOW);
    assert.throws(() => database.prepare("UPDATE stage_runs SET progress_json = 'not json' WHERE id = 2").run());
    database.prepare("UPDATE stage_runs SET progress_json = '{\"done\":1,\"total\":3}' WHERE id = 2").run();

    database.prepare('DELETE FROM stage_runs WHERE id = 1').run();

    const row = database.prepare('SELECT source_run_id AS sourceRunId FROM stage_runs WHERE id = 2').get() as {
      sourceRunId: number | null;
    };
    assert.equal(row.sourceRunId, null);
  } finally {
    database.close();
  }
});

test('剧本包结构快照默认为空对象且必须是合法 JSON；模型类型默认视频且只允许文本、图像、音频、视频四种', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    seedWorkWithEpisode(database);
    database
      .prepare("INSERT INTO stage_runs (work_id, stage, version, input_json, created_at) VALUES (1, 'screenplay', 1, '{}', ?)")
      .run(NOW);
    database
      .prepare("INSERT INTO screenplays (run_id, title, overview, full_text, updated_at) VALUES (1, '标题', '梗概', '正文', ?)")
      .run(NOW);
    const screenplay = database.prepare('SELECT structure_json AS structure FROM screenplays WHERE id = 1').get() as {
      structure: string;
    };
    assert.equal(screenplay.structure, '{}');
    assert.throws(() => database.prepare("UPDATE screenplays SET structure_json = 'not json' WHERE id = 1").run());

    database
      .prepare("INSERT INTO providers (code, display_name, created_at, updated_at) VALUES ('demo', '示例', ?, ?)")
      .run(NOW, NOW);
    database.prepare("INSERT INTO models (provider_id, code, display_name, created_at) VALUES (1, 'v1', '视频', ?)").run(NOW);
    database
      .prepare("INSERT INTO models (provider_id, code, display_name, kind, created_at) VALUES (1, 'i1', '图像', 'image', ?)")
      .run(NOW);
    database
      .prepare("INSERT INTO models (provider_id, code, display_name, kind, created_at) VALUES (1, 't1', '文本', 'text', ?)")
      .run(NOW);
    assert.throws(() =>
      database
        .prepare("INSERT INTO models (provider_id, code, display_name, kind, created_at) VALUES (1, 'x1', '未知', 'unknown', ?)")
        .run(NOW)
    );
    const kinds = database.prepare('SELECT kind FROM models ORDER BY id').all() as { kind: string }[];
    assert.deepEqual(
      kinds.map((row) => row.kind),
      ['video', 'image', 'text']
    );
  } finally {
    database.close();
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

test('生成参数：镜头组级每组一条并随镜头组删除，声音模式只允许无声和模型原生，时长必须大于 0', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    const { workId, episodeId } = seedWorkWithEpisode(database);
    database.prepare("INSERT INTO generation_profiles (scope, work_id, aspect_ratio, resolution, updated_at) VALUES ('work', ?, '16:9', '720P', ?)").run(workId, NOW);
    database.prepare("INSERT INTO generation_profiles (scope, episode_id, aspect_ratio, updated_at) VALUES ('episode', ?, '9:16', ?)").run(episodeId, NOW);
    database.prepare("INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (?, ?, 'storyboard_script', 1, '{}', ?)").run(workId, episodeId, NOW);
    database.prepare('INSERT INTO storyboard_scripts (run_id, episode_id, created_at) VALUES (1, ?, ?)').run(episodeId, NOW);
    database.prepare('INSERT INTO shot_groups (storyboard_script_id, seq, created_at) VALUES (1, 1, ?)').run(NOW);
    database.prepare("INSERT INTO generation_profiles (scope, group_id, audio_mode, duration_seconds, updated_at) VALUES ('group', 1, 'none', 7.5, ?)").run(NOW);

    assert.throws(() => database.prepare("INSERT INTO generation_profiles (scope, group_id, work_id, updated_at) VALUES ('group', 1, ?, ?)").run(workId, NOW), '范围为镜头组时不能同时指定作品');
    assert.throws(() => database.prepare("INSERT INTO generation_profiles (scope, group_id, resolution, updated_at) VALUES ('group', 1, '720P', ?)").run(NOW), '同一个镜头组只有一条覆盖');
    assert.throws(() => database.prepare("UPDATE generation_profiles SET audio_mode = 'external' WHERE scope = 'work'").run(), '不再允许 external');
    assert.throws(() => database.prepare("UPDATE generation_profiles SET duration_seconds = 0 WHERE scope = 'group'").run(), '时长必须大于 0');

    database.prepare('DELETE FROM shot_groups WHERE id = 1').run();
    assert.equal(countRows(database, 'generation_profiles'), 2, '镜头组删除后它的覆盖随之清除');
  } finally {
    database.close();
  }
});

test('生成参数：种子、声音内容、时长、负向清单与提示词改写可往返保存，改写开关只允许 0 或 1', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    const { workId, episodeId } = seedWorkWithEpisode(database);
    const profiles = new SqliteGenerationProfileRepository(database);
    const work = {
      ...EMPTY_PROFILE,
      audioMode: 'native' as const,
      audioElements: ['dialogue' as const, 'music' as const],
      seed: 0,
      durationSeconds: 7.5,
      negativeList: '不要字幕，不要水印',
      promptExtend: false
    };
    profiles.save({ scope: 'work', workId }, work, NOW);
    assert.deepEqual(profiles.find({ scope: 'work', workId }), work, '关闭（0）与 null 不混淆');
    const episode = { ...EMPTY_PROFILE, negativeList: '', promptExtend: true };
    profiles.save({ scope: 'episode', episodeId }, episode, NOW);
    assert.deepEqual(profiles.find({ scope: 'episode', episodeId }), episode, '空串与 null 不混淆');
    assert.throws(() => database.prepare("UPDATE generation_profiles SET prompt_extend = 2 WHERE scope = 'work'").run());
  } finally {
    database.close();
  }
});

test('资产分类：新资产不分类，分类在同类型内名称唯一，删除分类后资产保留并置空分类', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    database
      .prepare("INSERT INTO assets (kind, name, attributes_json, created_at, updated_at) VALUES ('character', '林夏', '{}', ?, ?)")
      .run(NOW, NOW);
    assert.deepEqual({ ...database.prepare('SELECT category_id FROM assets').get() }, { category_id: null });

    database.prepare("INSERT INTO asset_categories (kind, name, created_at, updated_at) VALUES ('character', '主角', ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO asset_categories (kind, name, created_at, updated_at) VALUES ('scene', '主角', ?, ?)").run(NOW, NOW);
    assert.throws(
      () => database.prepare("INSERT INTO asset_categories (kind, name, created_at, updated_at) VALUES ('character', '主角', ?, ?)").run(NOW, NOW),
      '同一类型内分类名称唯一'
    );
    assert.throws(
      () => database.prepare("INSERT INTO asset_categories (kind, name, created_at, updated_at) VALUES ('bogus', '甲', ?, ?)").run(NOW, NOW),
      '类型必须是五种之一'
    );
    assert.throws(() => database.prepare('UPDATE assets SET category_id = 0').run(), '不存在的分类（包括 0）违反外键');

    database.prepare('UPDATE assets SET category_id = 1').run();
    database.prepare('DELETE FROM asset_categories WHERE id = 1').run();
    assert.equal(countRows(database, 'assets'), 1);
    assert.deepEqual({ ...database.prepare('SELECT category_id FROM assets').get() }, { category_id: null });
  } finally {
    database.close();
  }
});

test('资产文件：内容存磁盘只记路径，来源只允许上传或生成，资产默认使用生成来源', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    database.prepare("INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('character', '林夏', ?, ?)").run(NOW, NOW);
    assert.deepEqual({ ...database.prepare('SELECT file_source FROM assets').get() }, { file_source: 'generated' });

    const insertFile = (source: string) =>
      database
        .prepare("INSERT INTO asset_files (asset_id, source, file_name, mime, size_bytes, file_path, created_at) VALUES (1, ?, 'a.png', 'image/png', 1, 'assets/a.png', ?)")
        .run(source, NOW);
    insertFile('upload');
    insertFile('generated');
    assert.throws(() => insertFile('bogus'));
    assert.throws(() => database.prepare("UPDATE assets SET file_source = 'bogus'").run());

    const columns = (database.prepare('PRAGMA table_info(asset_files)').all() as Array<{ name: string }>).map((column) => column.name);
    assert.ok(columns.includes('file_path') && !columns.includes('content'));
  } finally {
    database.close();
  }
});

test('作品文本模型：每个作品最多一行，作品必须存在，模型键不能为空，作品删除时级联清除', () => {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    const { workId } = seedWorkWithEpisode(database);
    assert.equal(countRows(database, 'work_text_models'), 0);

    database.prepare("INSERT INTO work_text_models (work_id, model_key, updated_at) VALUES (?, 'copilot:', ?)").run(workId, NOW);
    assert.throws(() => database.prepare("INSERT INTO work_text_models (work_id, model_key, updated_at) VALUES (?, 'copilot:gpt', ?)").run(workId, NOW), '每个作品最多一行');
    assert.throws(() => database.prepare("INSERT INTO work_text_models (work_id, model_key, updated_at) VALUES (999, 'copilot:', ?)").run(NOW), '作品必须存在');
    assert.throws(() => database.prepare("UPDATE work_text_models SET model_key = ''").run(), '模型键不能为空');
    database.prepare('DELETE FROM works WHERE id = ?').run(workId);
    assert.equal(countRows(database, 'work_text_models'), 0);
  } finally {
    database.close();
  }
});