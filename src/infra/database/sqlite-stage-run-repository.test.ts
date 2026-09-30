// ------------------------------------------------------------------------
// 名称：sqlite-stage-run-repository.test.ts
// 说明：阶段记录、创意章节与作品素材读取的 SQLite 实现的自动化测试：版本、状态保护、确认采用、进度往返、级联。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { NewStageRun, StageTarget } from '../../domain/models/stage-run';
import { createApprovalPatch, createEditPatch } from '../../domain/rules/stage-review-rules';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { SqliteChapterRepository, SqliteStageRunRepository } from './sqlite-stage-run-repository';
import { SqliteWorkSourceReader } from './sqlite-work-source-reader';

const NOW = '2026-01-01T00:00:00.000Z';
const CREATIVE: StageTarget = { workId: 1, stage: 'creative', episodeId: null };
const STORYBOARD: StageTarget = { workId: 1, stage: 'storyboard_script', episodeId: 1 };

/** 创建带一个项目、一个作品、一集的内存库。 */
function createDatabase(): DatabaseSync {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('项目甲', NOW, NOW);
  database
    .prepare('INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
    .run('作品甲', 'series', NOW, NOW);
  database
    .prepare('INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (1, 1, ?, ?, ?)')
    .run('第一集', NOW, NOW);
  return database;
}

/** 构造创建阶段记录的输入。 */
function newRun(target: StageTarget, overrides: Partial<NewStageRun> = {}): NewStageRun {
  return { ...target, input: { sourceType: 'text' }, sourceRunId: null, sourceRevision: null, modelInfo: 'copilot/test', ...overrides };
}

test('创建：版本号按目标递增，输入快照与默认状态正确，分镜脚本按集独立编号', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const first = runs.create(newRun(CREATIVE, { input: { params: { maxChapters: 3 }, 备注: '中文' } }), NOW);
    runs.markFailed(first.id, '失败', null, NOW);
    const second = runs.create(newRun(CREATIVE), NOW);
    const storyboard = runs.create(newRun(STORYBOARD), NOW);

    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(storyboard.version, 1);
    assert.deepEqual(first.input, { params: { maxChapters: 3 }, 备注: '中文' });
    assert.equal(first.status, 'running');
    assert.equal(first.reviewStatus, 'pending');
    assert.equal(first.isCurrent, false);
    assert.equal(first.revision, 1);
    assert.equal(first.modelInfo, 'copilot/test');
    assert.equal(first.progress, null);
    assert.deepEqual(
      runs.listVersions(CREATIVE).map((run) => run.version),
      [2, 1]
    );
  } finally {
    database.close();
  }
});

test('同一目标同时只能有一条运行中的记录', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const running = runs.create(newRun(CREATIVE), NOW);
    assert.equal(runs.findRunning(CREATIVE)?.id, running.id);
    assert.throws(() => runs.create(newRun(CREATIVE), NOW));
    assert.equal(runs.findRunning(STORYBOARD), undefined);
    runs.create(newRun(STORYBOARD), NOW);
  } finally {
    database.close();
  }
});

test('状态变更受保护：只有运行中的记录能标记成功、失败或取消，只有失败或已取消的能重新运行', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const run = runs.create(newRun(CREATIVE), NOW);

    assert.equal(runs.markRunning(run.id)?.status, 'running', '运行中的记录不受影响');
    const succeeded = runs.markSucceeded(run.id, '2026-01-01T00:01:00.000Z')!;
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.finishedAt, '2026-01-01T00:01:00.000Z');
    assert.equal(runs.markFailed(run.id, '迟到的失败', null, NOW)?.status, 'succeeded', '已成功的记录不能再标记失败');
    assert.equal(runs.markCanceled(run.id, NOW)?.status, 'succeeded');
    assert.equal(runs.markRunning(run.id)?.status, 'succeeded');
  } finally {
    database.close();
  }
});

test('失败保留错误与原始输出，重新运行时清除并保留进度', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const run = runs.create(newRun(CREATIVE), NOW);
    runs.updateProgress(run.id, { step: '规划大纲', total: 4, done: 1, detail: { outline: [{ seq: 1, title: '甲' }] } });

    const failed = runs.markFailed(run.id, '输出不合规', '原始输出', NOW)!;
    assert.equal(failed.errorMessage, '输出不合规');
    assert.equal(failed.rawOutput, '原始输出');

    const resumed = runs.markRunning(run.id)!;
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.errorMessage, null);
    assert.equal(resumed.rawOutput, null);
    assert.equal(resumed.finishedAt, null);
    assert.deepEqual(resumed.progress, { step: '规划大纲', total: 4, done: 1, detail: { outline: [{ seq: 1, title: '甲' }] } });
  } finally {
    database.close();
  }
});

test('确认采用：原来的当前版本变为历史，新版本成为当前版本', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const first = runs.create(newRun(CREATIVE), NOW);
    runs.markSucceeded(first.id, NOW);
    runs.approve(first.id, createApprovalPatch(runs.findById(first.id)!, NOW));
    const second = runs.create(newRun(CREATIVE), NOW);
    runs.markSucceeded(second.id, NOW);

    const approved = runs.approve(second.id, createApprovalPatch(runs.findById(second.id)!, '2026-01-02T00:00:00.000Z'))!;

    assert.equal(approved.isCurrent, true);
    assert.equal(approved.reviewStatus, 'approved');
    assert.equal(approved.approvedAt, '2026-01-02T00:00:00.000Z');
    assert.equal(runs.findCurrent(CREATIVE)?.id, second.id);
    const history = runs.findById(first.id)!;
    assert.equal(history.isCurrent, false);
    assert.equal(history.reviewStatus, 'approved');
  } finally {
    database.close();
  }
});

test('编辑产出后回到待确认，不再是当前版本，修订号加 1', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const run = runs.create(newRun(CREATIVE), NOW);
    runs.markSucceeded(run.id, NOW);
    runs.approve(run.id, createApprovalPatch(runs.findById(run.id)!, NOW));

    const edited = runs.applyEdit(run.id, createEditPatch(runs.findById(run.id)!))!;

    assert.equal(edited.reviewStatus, 'pending');
    assert.equal(edited.isCurrent, false);
    assert.equal(edited.revision, 2);
    assert.equal(runs.findCurrent(CREATIVE), undefined);
  } finally {
    database.close();
  }
});

test('启动恢复：所有运行中的记录被置为失败并写入原因', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const running = runs.create(newRun(CREATIVE), NOW);
    const done = runs.create(newRun(STORYBOARD), NOW);
    runs.markSucceeded(done.id, NOW);

    assert.equal(runs.failInterrupted('扩展重启，已中断。', NOW), 1);

    assert.equal(runs.findById(running.id)?.status, 'failed');
    assert.equal(runs.findById(running.id)?.errorMessage, '扩展重启，已中断。');
    assert.equal(runs.findById(done.id)?.status, 'succeeded');
    assert.equal(runs.failInterrupted('x', NOW), 0);
  } finally {
    database.close();
  }
});

test('章节：按序号排序，同一序号覆盖，随阶段记录级联删除', () => {
  const database = createDatabase();
  try {
    const runs = new SqliteStageRunRepository(database);
    const chapters = new SqliteChapterRepository(database);
    const run = runs.create(newRun(CREATIVE), NOW);

    chapters.save(run.id, { seq: 2, title: '乙', content: '第二章' }, NOW);
    chapters.save(run.id, { seq: 1, title: '甲', content: '第一章' }, NOW);
    chapters.save(run.id, { seq: 1, title: '甲改', content: '第一章改' }, NOW);

    assert.deepEqual(chapters.list(run.id), [
      { seq: 1, title: '甲改', content: '第一章改' },
      { seq: 2, title: '乙', content: '第二章' }
    ]);

    database.prepare('DELETE FROM stage_runs WHERE id = ?').run(run.id);
    assert.deepEqual(chapters.list(run.id), []);
  } finally {
    database.close();
  }
});

test('素材读取：小说原文按 UTF-8 还原，图片按顺序读取，没有素材时返回空', () => {
  const database = createDatabase();
  try {
    const reader = new SqliteWorkSourceReader(database);
    assert.equal(reader.readNovelText(1), undefined);
    assert.deepEqual(reader.readImages(1), []);

    const insert = database.prepare(
      'INSERT INTO work_sources (work_id, kind, file_name, mime, size_bytes, content, sort_order, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
    );
    const novel = Buffer.from('第一章 灯塔\n守夜人。', 'utf8');
    insert.run('novel_text', 'novel.txt', 'text/plain', novel.length, novel, 0, NOW);
    insert.run('image', 'b.png', 'image/png', 2, new Uint8Array([2, 2]), 1, NOW);
    insert.run('image', 'a.jpg', 'image/jpeg', 1, new Uint8Array([1]), 0, NOW);

    assert.equal(reader.readNovelText(1), '第一章 灯塔\n守夜人。');
    const images = reader.readImages(1);
    assert.deepEqual(
      images.map((image) => [image.mimeType, [...image.data]]),
      [
        ['image/jpeg', [1]],
        ['image/png', [2, 2]]
      ]
    );
  } finally {
    database.close();
  }
});
