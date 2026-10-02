// ------------------------------------------------------------------------
// 名称：generation-profile-service.test.ts
// 说明：生成参数的自动化测试：修改请求的读取与校验、按本集 → 作品 → 项目默认合并并记录来源、SQLite 仓库的保存与恢复继承、服务的归属与模型校验、变化通知、作品删除时级联清除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库；作品、集用 SQL 直接写入；模型经假适配器同步入库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { EMPTY_PROFILE } from '../../domain/models/generation-profile';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FakeImageProvider, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { applyProfileChanges, readProfileChanges, resolveProfile } from '../../domain/rules/generation-profile-rules';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteGenerationProfileRepository } from '../../infra/database/sqlite-generation-profile-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from '../../infra/database/sqlite-screenplay-repository';
import { SqliteStageRunRepository } from '../../infra/database/sqlite-stage-run-repository';
import { SqliteWorkRepository } from '../../infra/database/sqlite-work-repository';
import { GenerationProfileService } from './generation-profile-service';
import { ProjectService } from './project-service';
import { ProviderService } from './provider-service';
import { WorkService } from './work-service';

/** 创建服务、一个带默认画幅的项目、两个作品各带集，以及视频与图像模型。 */
function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const project = projects.createProject({ name: '项目甲', defaultAspectRatio: '16:9' });
  const works = new WorkService(new SqliteWorkRepository(database), new SqliteStageRunRepository(database));
  const providerRepository = new SqliteProviderRepository(database);
  new ProviderService({
    repository: providerRepository,
    registry: new ProviderRegistry().register(new FakeVideoProvider()).register(new FakeImageProvider()),
    secrets: new MemorySecretStore()
  }).syncCatalog();
  const videoModel = providerRepository.listModels({ kind: 'video' })[0];
  const imageModel = providerRepository.listModels({ kind: 'image' })[0];

  const insert = (sql: string, ...params: Array<string | number>) => Number(database.prepare(sql).run(...params).lastInsertRowid);
  const workA = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'series', 't', 't')", project.id);
  const workB = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品乙', 'series', 't', 't')", project.id);
  const episode = (workId: number, seq: number) =>
    insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, ?, '集', 't', 't')", workId, seq);
  const episodeA1 = episode(workA, 1);
  const episodeA2 = episode(workA, 2);
  const episodeB1 = episode(workB, 1);

  const repository = new SqliteGenerationProfileRepository(database);
  const service = new GenerationProfileService({
    profiles: repository,
    works,
    projects,
    screenplays: new SqliteScreenplayRepository(database),
    models: providerRepository,
    now: () => new Date('2026-10-02T00:00:00.000Z')
  });
  return { database, service, repository, workA, workB, episodeA1, episodeA2, episodeB1, videoModel, imageModel };
}

test('读取修改请求：空串按恢复继承，未知字段、非法值与空修改被拒绝', () => {
  assert.deepEqual(readProfileChanges({ aspectRatio: '9:16', resolution: '', modelId: 3, audioMode: 'none' }), {
    aspectRatio: '9:16',
    resolution: null,
    modelId: 3,
    audioMode: 'none'
  });
  assert.deepEqual(readProfileChanges({ modelId: null }), { modelId: null });
  const fieldErrors = (changes: unknown) => {
    try {
      readProfileChanges(changes);
    } catch (error) {
      return error instanceof ValidationError ? error.fieldErrors : undefined;
    }
    return undefined;
  };
  assert.ok(fieldErrors({ modelId: 'x' })?.modelId);
  assert.ok(fieldErrors({ modelId: 1.5 })?.modelId);
  assert.ok(fieldErrors({ aspectRatio: 'x'.repeat(21) })?.aspectRatio);
  assert.ok(fieldErrors({ resolution: 7 })?.resolution);
  assert.ok(fieldErrors({ audioMode: 'external' })?.audioMode);
  assert.ok(fieldErrors({ seed: 1 })?.['']);
  assert.ok(fieldErrors({})?.['']);
  assert.ok(fieldErrors('x')?.['']);
});

test('合并：本集优先于作品，作品优先于项目默认，并记录每个值的来源', () => {
  const work = { ...EMPTY_PROFILE, modelId: 1, resolution: '720P', audioMode: 'native' as const };
  const episode = { ...EMPTY_PROFILE, resolution: '1080P' };
  const effective = resolveProfile(work, episode, { aspectRatio: '16:9', resolution: '480P' });
  assert.deepEqual(effective.values, { modelId: 1, aspectRatio: '16:9', resolution: '1080P', audioMode: 'native' });
  assert.deepEqual(effective.sources, { modelId: 'work', aspectRatio: 'project', resolution: 'episode', audioMode: 'work' });

  const none = resolveProfile(EMPTY_PROFILE, EMPTY_PROFILE, { aspectRatio: null, resolution: null });
  assert.deepEqual(none.values, EMPTY_PROFILE);
  assert.deepEqual(Object.values(none.sources), ['none', 'none', 'none', 'none']);
  assert.deepEqual(applyProfileChanges(work, { resolution: null }), { ...work, resolution: null });
});

test('保存与读取：作品与集各自保存，恢复继承后回退到上一级，项目默认作为最后回退', () => {
  const { database, service, workA, episodeA1, episodeA2, videoModel } = createFixture();
  try {
    const initial = service.getView(workA, episodeA1);
    assert.deepEqual(initial.work, EMPTY_PROFILE);
    assert.deepEqual([initial.effective.values.aspectRatio, initial.effective.sources.aspectRatio], ['16:9', 'project']);

    service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: { modelId: videoModel.id, aspectRatio: '9:16', resolution: '720P' } });
    const episodeSaved = service.save({ scope: 'episode', workId: workA, episodeId: episodeA1, changes: { resolution: '1080P' } });
    assert.deepEqual(episodeSaved.effective.values, { modelId: videoModel.id, aspectRatio: '9:16', resolution: '1080P', audioMode: null });
    assert.deepEqual(episodeSaved.effective.sources, { modelId: 'work', aspectRatio: 'work', resolution: 'episode', audioMode: 'none' });

    const other = service.getView(workA, episodeA2);
    assert.deepEqual([other.effective.values.resolution, other.effective.sources.resolution], ['720P', 'work'], '另一集不受本集覆盖影响');

    const restored = service.save({ scope: 'episode', workId: workA, episodeId: episodeA1, changes: { resolution: null } });
    assert.deepEqual([restored.effective.values.resolution, restored.effective.sources.resolution], ['720P', 'work']);
    const cleared = service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: { aspectRatio: null } });
    assert.deepEqual([cleared.effective.values.aspectRatio, cleared.effective.sources.aspectRatio], ['16:9', 'project']);
    assert.equal(cleared.work.modelId, videoModel.id, '只改传入的字段');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM generation_profiles').get()?.n, 1 + 1, '每个目标一行');
  } finally {
    database.close();
  }
});

test('保存校验：集必须属于作品，模型必须是存在的视频模型，范围必须合法', () => {
  const { database, service, workA, episodeA1, episodeB1, imageModel } = createFixture();
  try {
    assert.throws(() => service.save({ scope: 'work', workId: workA, episodeId: episodeB1, changes: { resolution: '720P' } }), NotFoundError);
    assert.throws(() => service.save({ scope: 'work', workId: 9999, episodeId: episodeA1, changes: { resolution: '720P' } }), NotFoundError);
    assert.throws(() => service.getView(workA, episodeB1), NotFoundError);
    assert.throws(() => service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: { modelId: 9999 } }), ValidationError);
    assert.throws(() => service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: { modelId: imageModel.id } }), ValidationError);
    assert.throws(() => service.save({ scope: 'shot', workId: workA, episodeId: episodeA1, changes: { resolution: '720P' } }), ValidationError);
    assert.throws(() => service.save({ scope: 'work', workId: 'x', episodeId: episodeA1, changes: { resolution: '720P' } }), ValidationError);
  } finally {
    database.close();
  }
});

test('保存后通知订阅者；失败的保存不通知；删除作品时参数随之清除', () => {
  const { database, service, workA, episodeA1 } = createFixture();
  try {
    let count = 0;
    service.onDidChangeProfiles(() => {
      count += 1;
    });
    service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: { resolution: '720P' } });
    service.save({ scope: 'episode', workId: workA, episodeId: episodeA1, changes: { audioMode: 'none' } });
    assert.throws(() => service.save({ scope: 'work', workId: workA, episodeId: episodeA1, changes: {} }));
    assert.equal(count, 2);

    database.prepare('DELETE FROM works WHERE id = ?').run(workA);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM generation_profiles').get()?.n, 0);
  } finally {
    database.close();
  }
});

test('作品默认：读取时回退到项目默认且不含集覆盖；保存只改出现的字段，校验模型并通知订阅者', () => {
  const { database, service, workA, episodeA1, videoModel, imageModel } = createFixture();
  try {
    const changed: number[] = [];
    service.onDidChangeProfiles(() => changed.push(1));
    assert.deepEqual(service.getWorkDefaults(workA).values, { ...EMPTY_PROFILE, aspectRatio: '16:9' });

    service.save({ scope: 'episode', workId: workA, episodeId: episodeA1, changes: { resolution: '1080P' } });
    service.saveWorkDefaults(workA, { modelId: videoModel.id, resolution: '720P' });
    service.saveWorkDefaults(workA, { aspectRatio: '9:16' });
    assert.deepEqual(service.getWorkDefaults(workA).values, { modelId: videoModel.id, aspectRatio: '9:16', resolution: '720P', audioMode: null });
    assert.equal(service.getView(workA, episodeA1).effective.values.resolution, '1080P', '本集覆盖仍然优先');

    const before = changed.length;
    assert.throws(() => service.saveWorkDefaults(workA, { modelId: imageModel.id }), ValidationError);
    assert.throws(() => service.saveWorkDefaults(workA, {}), ValidationError);
    assert.throws(() => service.saveWorkDefaults(9999, { aspectRatio: '16:9' }), NotFoundError);
    assert.equal(changed.length, before);
  } finally {
    database.close();
  }
});
