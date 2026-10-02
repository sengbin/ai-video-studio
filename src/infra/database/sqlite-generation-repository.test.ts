// ------------------------------------------------------------------------
// 名称：sqlite-generation-repository.test.ts
// 说明：生成任务仓库的自动化测试：新增与尝试次数、状态变更只作用于进行中的任务、成功写结果并自动采用、失败原因往返、素材读取、镜头组删除的连带清除、迁移 8 的升级。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库与种子数据。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobSnapshot } from '../../domain/models/generation';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { readSchemaVersion } from './migration-runner';
import { MIGRATIONS } from './migrations';
import { SqliteGenerationRepository } from './sqlite-generation-repository';
import { seedGeneration } from './testing/seed-generation';

const T1 = '2026-10-02T01:00:00.000Z';
const T2 = '2026-10-02T02:00:00.000Z';

const SNAPSHOT: JobSnapshot = {
  storyboardRunId: 1,
  shotIds: [1],
  providerCode: 'fake',
  modelCode: 'fake-video',
  prompt: '提示词',
  params: { aspectRatio: '16:9', resolution: '720P', durationSeconds: 4, audioMode: 'native', seed: null, extraParams: {} },
  referenceImageFileIds: [],
  referenceAudioFileIds: [],
  warnings: ['提醒']
};

const RESULT = { filePath: 'videos/1/1/1/1-1.mp4', remoteUrl: null, durationSeconds: 4, width: null, height: null, sizeBytes: 100, hasAudio: true };

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const seed = seedGeneration(database);
  const repository = new SqliteGenerationRepository(database);
  const insert = (groupId = seed.groupIds[0]) => repository.insertJob({ groupId, modelId: seed.modelId, status: 'queued', snapshot: SNAPSHOT, prevJobId: null, firstFrameId: null }, T1);
  return { database, seed, repository, insert };
}

test('新增任务：快照往返，同一镜头组的提交次数递增，不同组各自计数', () => {
  const { database, seed, repository, insert } = createFixture();
  try {
    const first = insert();
    assert.deepEqual([first.status, first.attempt, first.remoteJobId, first.failure, first.submittedAt, first.snapshot], ['queued', 1, null, null, null, SNAPSHOT]);
    assert.equal(insert().attempt, 2);
    assert.equal(insert(seed.groupIds[1]).attempt, 1);
    assert.deepEqual(repository.listJobsByGroups([seed.groupIds[0]]).map((job) => job.attempt), [2, 1], '最新的在前');
    assert.deepEqual(repository.listJobsByGroups([]), []);
    assert.equal(repository.findJob(999), undefined);
  } finally {
    database.close();
  }
});

test('状态流转：排队 → 生成中 → 成功；已结束的任务不能再改状态', () => {
  const { database, repository, insert } = createFixture();
  try {
    const job = insert();
    assert.equal(repository.hasActiveJob(job.groupId), true);
    assert.deepEqual(repository.listJobsByStatus(['queued']).map((item) => item.id), [job.id]);

    assert.equal(repository.markSubmitted(job.id, 'remote-1', T2), true);
    assert.equal(repository.markSubmitted(job.id, 'remote-2', T2), false, '只有排队中的任务才能提交');
    const running = repository.findJob(job.id);
    assert.deepEqual([running?.status, running?.remoteJobId, running?.submittedAt], ['running', 'remote-1', T2]);

    const result = repository.markSucceeded(job.id, RESULT, T2);
    assert.ok(result !== undefined && result.isSelected, '镜头组首个成功结果自动采用');
    assert.deepEqual([result.hasAudio, result.width, result.sizeBytes], [true, null, 100]);
    assert.equal(repository.findJob(job.id)?.status, 'succeeded');
    assert.equal(repository.hasActiveJob(job.groupId), false);

    assert.equal(repository.markFailed(job.id, { category: 'server', code: null, message: 'x' }, T2), false);
    assert.equal(repository.markCanceled(job.id, T2), false);
    assert.equal(repository.markSucceeded(job.id, RESULT, T2), undefined);
    assert.deepEqual(repository.listResultsByGroups([job.groupId]).map((item) => item.id), [result.id]);
    assert.equal(repository.findResult(result.id)?.filePath, RESULT.filePath);
  } finally {
    database.close();
  }
});

test('同一镜头组的第二个成功结果不抢占已采用的版本', () => {
  const { database, repository, insert } = createFixture();
  try {
    const [a, b] = [insert(), insert()];
    for (const job of [a, b]) repository.markSubmitted(job.id, `r${job.id}`, T2);
    const first = repository.markSucceeded(a.id, RESULT, T2);
    const second = repository.markSucceeded(b.id, { ...RESULT, filePath: 'videos/1/1/1/1-2.mp4' }, T2);
    assert.deepEqual([first?.isSelected, second?.isSelected], [true, false]);
  } finally {
    database.close();
  }
});

test('失败：原因（分类、错误码、原文）往返；取消后不能改写为失败', () => {
  const { database, repository, insert } = createFixture();
  try {
    const failed = insert();
    assert.equal(repository.markFailed(failed.id, { category: 'content_rejected', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, T2), true);
    const stored = repository.findJob(failed.id);
    assert.equal(stored?.status, 'failed');
    assert.deepEqual(stored?.failure, { category: 'content_rejected', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' });
    assert.equal(stored?.finishedAt, T2);

    const canceled = insert();
    assert.equal(repository.markCanceled(canceled.id, T2), true);
    assert.equal(repository.markFailed(canceled.id, { category: 'server', code: null, message: 'x' }, T2), false);
    assert.equal(repository.findJob(canceled.id)?.failure, null);
    assert.equal(repository.hasActiveJob(canceled.groupId), false);
  } finally {
    database.close();
  }
});

test('镜头组所在位置与素材内容读取', () => {
  const { database, seed, repository } = createFixture();
  try {
    assert.deepEqual(repository.getGroupLocation(seed.groupIds[0]), { projectId: seed.projectId, workId: seed.workId, episodeId: seed.episodeId });
    assert.equal(repository.getGroupLocation(999), undefined);

    database.prepare("INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('character', '角色', 't', 't')").run();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const fileId = Number(
      database
        .prepare("INSERT INTO asset_files (asset_id, role, file_name, mime, size_bytes, content, sort_order, created_at) VALUES (1, 'reference', 'a.png', 'image/png', ?, ?, 0, 't')")
        .run(png.length, png).lastInsertRowid
    );
    const media = repository.readAssetFile(fileId);
    assert.equal(media?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(media?.data ?? []), png);
    assert.equal(repository.readAssetFile(999), undefined);
    assert.equal(repository.readResultFrame(1), undefined);
  } finally {
    database.close();
  }
});

test('删除镜头组时连带清除任务和结果，组内镜头保留且回到未分组；删除分镜脚本时组一并清除', () => {
  const { database, seed, repository, insert } = createFixture();
  try {
    const job = insert();
    repository.markSubmitted(job.id, 'r', T2);
    repository.markSucceeded(job.id, RESULT, T2);
    database.prepare('DELETE FROM shot_groups WHERE id = ?').run(seed.groupIds[0]);
    assert.equal(repository.findJob(job.id), undefined);
    assert.deepEqual(repository.listResultsByGroups([seed.groupIds[0]]), []);
    const shot = database.prepare('SELECT group_id FROM shots WHERE id = ?').get(seed.shotIds[0]) as unknown as { group_id: number | null };
    assert.equal(shot.group_id, null);

    const other = insert(seed.groupIds[1]);
    database.prepare('DELETE FROM storyboard_scripts WHERE run_id = ?').run(seed.runId);
    assert.equal(repository.findJob(other.id), undefined);
    assert.equal((database.prepare('SELECT COUNT(*) AS total FROM shot_groups').get() as unknown as { total: number }).total, 0);
  } finally {
    database.close();
  }
});

const TAIL_FRAME = { mimeType: 'image/jpeg', width: 64, height: 36, data: new Uint8Array([7, 8, 9]) };

test('尾帧：保存后可读取，重复保存替换旧的；结果不存在时不保存；删除结果时一并清除', () => {
  const { database, repository, insert } = createFixture();
  try {
    const job = insert();
    repository.markSubmitted(job.id, 'r', T2);
    const result = repository.markSucceeded(job.id, RESULT, T2);
    assert.ok(result);
    assert.equal(repository.findResultByJob(job.id)?.id, result.id);
    assert.equal(repository.findResultByJob(999), undefined);
    assert.equal(repository.findResultFrameId(result.id), undefined);
    assert.equal(repository.saveResultFrame(999, TAIL_FRAME, T2), undefined);

    const first = repository.saveResultFrame(result.id, TAIL_FRAME, T2);
    assert.ok(first !== undefined);
    const media = repository.readResultFrame(first);
    assert.equal(media?.mimeType, 'image/jpeg');
    assert.deepEqual(Array.from(media?.data ?? []), [7, 8, 9]);

    const second = repository.saveResultFrame(result.id, { ...TAIL_FRAME, data: new Uint8Array([1]) }, T2);
    assert.notEqual(second, first);
    assert.equal(repository.findResultFrameId(result.id), second);
    assert.equal(repository.readResultFrame(first), undefined, '旧的尾帧被替换');
    assert.equal((database.prepare('SELECT COUNT(*) AS total FROM result_frames').get() as unknown as { total: number }).total, 1);

    database.prepare('DELETE FROM video_results WHERE id = ?').run(result.id);
    assert.equal(repository.findResultFrameId(result.id), undefined);
  } finally {
    database.close();
  }
});

test('等待前序：写入时带前序和首帧；释放时记下首帧并转为排队，只对等待中的任务生效；列出需要尾帧的结果', () => {
  const { database, seed, repository, insert } = createFixture();
  try {
    const previous = insert();
    const waiting = repository.insertJob(
      { groupId: seed.groupIds[1], modelId: seed.modelId, status: 'waiting', snapshot: SNAPSHOT, prevJobId: previous.id, firstFrameId: null },
      T1
    );
    assert.deepEqual([waiting.status, waiting.prevJobId, waiting.firstFrameId], ['waiting', previous.id, null]);
    assert.equal(repository.hasActiveJob(seed.groupIds[1]), true, '等待前序也算进行中');
    assert.deepEqual(repository.listResultsAwaitingFrame(), [], '前序还没有结果');

    repository.markSubmitted(previous.id, 'r', T2);
    const result = repository.markSucceeded(previous.id, RESULT, T2);
    assert.ok(result);
    assert.deepEqual(repository.listResultsAwaitingFrame().map((item) => item.id), [result.id]);

    const frameId = repository.saveResultFrame(result.id, TAIL_FRAME, T2);
    assert.ok(frameId !== undefined);
    assert.deepEqual(repository.listResultsAwaitingFrame(), []);
    assert.equal(repository.releaseWaitingJob(previous.id, frameId), false, '只有等待前序的任务才能释放');
    assert.equal(repository.releaseWaitingJob(waiting.id, frameId), true);
    const released = repository.findJob(waiting.id);
    assert.deepEqual([released?.status, released?.firstFrameId], ['queued', frameId]);
    assert.equal(repository.releaseWaitingJob(waiting.id, frameId), false);

    const ready = repository.insertJob({ groupId: seed.groupIds[1], modelId: seed.modelId, status: 'queued', snapshot: SNAPSHOT, prevJobId: previous.id, firstFrameId: frameId }, T1);
    assert.equal(ready.firstFrameId, frameId);
  } finally {
    database.close();
  }
});

test('从版本 7 升级到 8：任务表改为挂在镜头组上，错误分类与服务商一致', () => {
  const legacy = openDatabase(IN_MEMORY_DATABASE_PATH, MIGRATIONS.slice(0, 7));
  try {
    assert.equal(readSchemaVersion(legacy), 7);
  } finally {
    legacy.close();
  }
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  try {
    assert.equal(readSchemaVersion(database), MIGRATIONS.length);
    const seed = seedGeneration(database, 1);
    const insertFailed = (category: string) =>
      database
        .prepare("INSERT INTO video_jobs (group_id, model_id, status, request_snapshot_json, error_category, created_at) VALUES (?, ?, 'failed', '{}', ?, 't')")
        .run(seed.groupIds[0], seed.modelId, category);
    insertFailed('content_rejected');
    assert.throws(() => insertFailed('rate_limit'), '旧的分类名称不再允许');
    assert.throws(
      () => database.prepare("INSERT INTO video_jobs (group_id, model_id, status, request_snapshot_json, error_category, created_at) VALUES (?, ?, 'queued', '{}', 'server', 't')").run(seed.groupIds[0], seed.modelId),
      '只有失败的任务才能有错误分类'
    );
  } finally {
    database.close();
  }
});
