// ------------------------------------------------------------------------
// 名称：binding-service.test.ts
// 说明：实体绑定服务（含 SQLite 仓库）与请求处理的自动化测试：绑定规则、主资产维护、解除、按名称自动匹配、试听音色参考。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库；作品、集、实体用 SQL 直接写入，资产经资产服务创建。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteBindingRepository } from '../../infra/database/sqlite-binding-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { MessageRouter } from '../messaging/message-router';
import { BINDING_REQUESTS, registerBindingHandlers } from '../pages/binding-handlers';
import { AssetService } from './asset-service';
import { BindingService } from './binding-service';
import { ProjectService } from './project-service';

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
const AUDIO_FILES = JSON.stringify([{ name: 'v.wav', mimeType: 'audio/wav', size: WAV.length, data: WAV.toString('base64'), durationSeconds: 3 }]);

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assetRepository = new SqliteAssetRepository(database);
  const assets = new AssetService(assetRepository);
  const service = new BindingService(new SqliteBindingRepository(database), assetRepository);
  projects.createProject({ name: '项目甲' });
  projects.createProject({ name: '项目乙' });

  const insert = (sql: string, ...params: Array<string | number>) => Number(database.prepare(sql).run(...params).lastInsertRowid);
  const work = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (1, '作品甲', 'series', 't', 't')");
  const episode1 = insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, '第一集', 't', 't')", work);
  const episode2 = insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 2, '第二集', 't', 't')", work);
  const entity = (kind: string, name: string, aliases = '[]', active = 1) =>
    insert(
      'INSERT INTO script_entities (work_id, kind, name, aliases_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      work, kind, name, aliases, active, 't', 't'
    );
  const guard = entity('character', '守夜人', '["老陈"]');
  const lighthouse = entity('scene', '灯塔');
  const retired = entity('prop', '旧钥匙', '[]', 0);
  const otherWork = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (2, '作品乙', 'single', 't', 't')");
  const otherEpisode = insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, '乙第一集', 't', 't')", otherWork);
  const otherEntity = insert(
    "INSERT INTO script_entities (work_id, kind, name, created_at, updated_at) VALUES (?, 'character', '外人', 't', 't')",
    otherWork
  );
  return { database, assets, service, work, episode1, episode2, guard, lighthouse, retired, otherEntity, otherEpisode };
}

test('形象绑定：同类型的资产可绑定，第一个自动成为主资产，之后的不是', () => {
  const { database, assets, service, episode1, guard } = createFixture();
  try {
    const first = assets.createAsset('character', { name: '守夜人·日常' });
    const second = assets.createAsset('character', { name: '守夜人·雨天' });

    const a = service.bind({ episodeId: episode1, entityId: guard, assetId: first.id, note: '日常造型' });
    const b = service.bind({ episodeId: episode1, entityId: guard, assetId: second.id, purpose: 'visual' });
    assert.deepEqual([a.isPrimary, a.purpose, a.note, a.entityName, a.assetName, a.assetKind], [true, 'visual', '日常造型', '守夜人', '守夜人·日常', 'character']);
    assert.equal(b.isPrimary, false);
    assert.deepEqual(service.listBindings(episode1).map((binding) => [binding.assetName, binding.isPrimary]), [
      ['守夜人·日常', true],
      ['守夜人·雨天', false]
    ]);

    // 绑定属于集：另一集互不影响，且在另一集同样自动成为主资产。
    assert.equal(service.listBindings(service.listBindings(episode1)[0].episodeId + 1).length, 0);
    assert.equal(service.bind({ episodeId: episode1 + 1, entityId: guard, assetId: second.id }).isPrimary, true);
  } finally {
    database.close();
  }
});

test('跨项目复用：同一个资产可以绑定到不同项目作品的实体', () => {
  const { database, assets, service, episode1, guard, otherEpisode, otherEntity } = createFixture();
  try {
    const shared = assets.createAsset('character', { name: '通用角色' });
    assert.equal(service.bind({ episodeId: episode1, entityId: guard, assetId: shared.id }).isPrimary, true);
    assert.equal(service.bind({ episodeId: otherEpisode, entityId: otherEntity, assetId: shared.id }).isPrimary, true);
    assert.equal(assets.listAssets('character')[0].episodeCount, 2);
    assert.deepEqual(service.getEpisodeView(otherEpisode).visualAssets.character.map((asset) => asset.name), ['通用角色']);
  } finally {
    database.close();
  }
});

test('绑定校验：类型、用途、重复、不存在与标识无效', () => {
  const { database, assets, service, episode1, guard, lighthouse, otherEntity } = createFixture();
  try {
    const character = assets.createAsset('character', { name: '甲角色' });
    const voice = assets.createAsset('audio', { name: '音色', audioKind: '音色参考', files: AUDIO_FILES });
    const music = assets.createAsset('audio', { name: '配乐', audioKind: 'music', files: AUDIO_FILES });
    const base = { episodeId: episode1, entityId: guard };
    const fieldError = (input: object) => {
      try {
        service.bind({ ...base, ...input });
      } catch (error) {
        return error instanceof ValidationError ? error.fieldErrors : undefined;
      }
      return undefined;
    };

    assert.ok(fieldError({ assetId: character.id, entityId: lighthouse })?.assetId, '角色资产不能绑定到场景实体');
    assert.ok(fieldError({ assetId: voice.id })?.assetId, '音频资产不能做形象绑定');
    assert.ok(fieldError({ assetId: character.id, purpose: 'voice' })?.assetId, '角色资产不能做音色绑定');
    assert.ok(fieldError({ assetId: music.id, purpose: 'voice' })?.assetId, '只有音色参考音频能做音色绑定');
    assert.ok(fieldError({ assetId: voice.id, entityId: lighthouse, purpose: 'voice' })?.[''], '只有角色可以绑定音色');
    assert.ok(fieldError({ assetId: character.id, purpose: 'bogus' })?.purpose);
    assert.ok(fieldError({ assetId: 'x', note: 'x'.repeat(201) })?.assetId);
    assert.throws(() => service.bind({ ...base, assetId: character.id, note: 'x'.repeat(201) }), (error) => error instanceof ValidationError && error.fieldErrors.note !== undefined);

    service.bind({ ...base, assetId: voice.id, purpose: 'voice' });
    assert.equal(service.bind({ ...base, assetId: character.id }).isPrimary, true, '形象与音色的主资产互相独立');

    assert.throws(() => service.bind({ ...base, assetId: character.id }), ConflictError);
    assert.throws(() => service.bind({ ...base, assetId: 9999 }), NotFoundError);
    assert.throws(() => service.bind({ ...base, episodeId: 9999, assetId: character.id }), NotFoundError);
    assert.throws(() => service.bind({ episodeId: episode1, entityId: otherEntity, assetId: character.id }), NotFoundError, '实体不属于这一集所在的作品');
  } finally {
    database.close();
  }
});

test('切换主资产与解除绑定：始终保持有绑定就有且只有一个主资产', () => {
  const { database, assets, service, episode1, guard } = createFixture();
  try {
    const ids = ['甲', '乙', '丙'].map((name) => assets.createAsset('character', { name }).id);
    const bindings = ids.map((assetId) => service.bind({ episodeId: episode1, entityId: guard, assetId }));
    const primaries = () => service.listBindings(episode1).filter((binding) => binding.isPrimary).map((binding) => binding.assetName);

    assert.deepEqual(primaries(), ['甲']);
    assert.equal(service.setPrimary(bindings[2].id).isPrimary, true);
    assert.deepEqual(primaries(), ['丙']);

    service.unbind(bindings[1].id);
    assert.deepEqual(primaries(), ['丙'], '解除非主资产不影响主资产');
    service.unbind(bindings[2].id);
    assert.deepEqual(primaries(), ['甲'], '主资产被解除后最早的绑定接任');
    service.unbind(bindings[0].id);
    assert.deepEqual(service.listBindings(episode1), []);

    assert.throws(() => service.unbind(bindings[0].id), NotFoundError);
    assert.throws(() => service.setPrimary(9999), NotFoundError);
  } finally {
    database.close();
  }
});

test('按名称自动匹配：实体名称或别名与同类型资产同名，已绑定的和停用实体不列入', () => {
  const { database, assets, service, episode1, guard, lighthouse } = createFixture();
  try {
    const old = assets.createAsset('character', { name: '老陈' });
    const exact = assets.createAsset('scene', { name: '灯塔' });
    assets.createAsset('prop', { name: '旧钥匙' });
    assets.createAsset('prop', { name: '灯塔' });

    assert.deepEqual(service.suggestMatches(episode1), [
      { entityId: guard, entityName: '守夜人', assetId: old.id, assetName: '老陈' },
      { entityId: lighthouse, entityName: '灯塔', assetId: exact.id, assetName: '灯塔' }
    ]);

    service.bind({ episodeId: episode1, entityId: lighthouse, assetId: exact.id });
    assert.deepEqual(service.suggestMatches(episode1).map((item) => item.assetName), ['老陈']);
    assert.throws(() => service.suggestMatches(9999), NotFoundError);
  } finally {
    database.close();
  }
});

test('绑定界面视图：只含启用的实体，可选资产不区分项目，主资产在前，音色只给角色', () => {
  const { database, assets, service, episode1, guard, lighthouse } = createFixture();
  try {
    const day = assets.createAsset('character', { name: '守夜人·日常' });
    const rain = assets.createAsset('character', { name: '守夜人·雨天' });
    assets.createAsset('scene', { name: '灯塔' });
    const voice = assets.createAsset('audio', { name: '低沉嗓音', audioKind: '音色参考', files: AUDIO_FILES });
    assets.createAsset('audio', { name: '配乐', audioKind: 'music', files: AUDIO_FILES });

    service.bind({ episodeId: episode1, entityId: guard, assetId: day.id });
    const second = service.bind({ episodeId: episode1, entityId: guard, assetId: rain.id });
    service.setPrimary(second.id);
    service.bind({ episodeId: episode1, entityId: guard, assetId: voice.id, purpose: 'voice' });

    const view = service.getEpisodeView(episode1);
    assert.deepEqual(view.entities.map((entity) => [entity.name, entity.kindLabel]), [['守夜人', '角色'], ['灯塔', '场景']], '停用的实体不出现');
    const [guardView, lighthouseView] = view.entities;
    assert.equal(guardView.entityId, guard);
    assert.deepEqual(guardView.visual.map((item) => [item.assetName, item.isPrimary]), [['守夜人·雨天', true], ['守夜人·日常', false]]);
    assert.deepEqual(guardView.voice.map((item) => [item.assetName, item.durationSeconds]), [['低沉嗓音', 3]]);
    assert.equal(lighthouseView.entityId, lighthouse);
    assert.deepEqual([lighthouseView.visual, lighthouseView.voice], [[], []]);

    assert.deepEqual(view.visualAssets.character.map((asset) => asset.name), ['守夜人·日常', '守夜人·雨天']);
    assert.deepEqual(view.visualAssets.scene.map((asset) => asset.name), ['灯塔']);
    assert.deepEqual(view.voiceAssets.map((asset) => asset.name), ['低沉嗓音'], '只含音色参考音频');
    assert.throws(() => service.getEpisodeView(9999), NotFoundError);
  } finally {
    database.close();
  }
});

test('音色绑定要求音频已有文件：还没有文件的音频不在可选列表里，也不能绑定', () => {
  const { database, assets, service, episode1, guard } = createFixture();
  try {
    const empty = assets.createAsset('audio', { name: '还没有文件', audioKind: '音色参考' });
    assert.deepEqual(service.getEpisodeView(episode1).voiceAssets, []);
    assert.throws(
      () => service.bind({ episodeId: episode1, entityId: guard, assetId: empty.id, purpose: 'voice' }),
      (error) => error instanceof ValidationError && /还没有音频文件/.test(error.fieldErrors.assetId)
    );
    const ready = assets.createAsset('audio', { name: '有文件', audioKind: '音色参考', files: AUDIO_FILES });
    assert.deepEqual(service.getEpisodeView(episode1).voiceAssets.map((asset) => asset.name), ['有文件']);
    assert.equal(service.bind({ episodeId: episode1, entityId: guard, assetId: ready.id, purpose: 'voice' }).isPrimary, true);
  } finally {
    database.close();
  }
});

test('试听音色参考：读取第一个参考文件的内容；不是音色参考、没有文件、资产不存在时报错', async () => {
  const { database, assets, service } = createFixture();
  try {
    const voice = assets.createAsset('audio', { name: '低沉嗓音', audioKind: '音色参考', files: AUDIO_FILES });
    assert.deepEqual(service.readVoiceAudio(voice.id), { mime: 'audio/wav', data: WAV.toString('base64') });

    const music = assets.createAsset('audio', { name: '背景乐', audioKind: 'music', files: AUDIO_FILES });
    assert.throws(
      () => service.readVoiceAudio(music.id),
      (error) => error instanceof ValidationError && /音色参考/.test(error.fieldErrors.assetId)
    );
    const character = assets.createAsset('character', { name: '守夜人' });
    assert.throws(() => service.readVoiceAudio(character.id), ValidationError);
    const empty = assets.createAsset('audio', { name: '还没有文件', audioKind: '音色参考' });
    assert.throws(() => service.readVoiceAudio(empty.id), (error) => error instanceof NotFoundError && /还没有音频文件/.test(error.message));
    assert.throws(() => service.readVoiceAudio(9999), NotFoundError);

    // 请求处理：载荷用 assetId，错误按类型返回。
    const router = new MessageRouter();
    registerBindingHandlers(router, service);
    const send = (payload?: unknown) => router.handle({ type: 'request', requestId: 1, name: BINDING_REQUESTS.voiceAudio, payload });
    const ok = await send({ assetId: voice.id });
    assert.deepEqual(ok?.ok && ok.data, { mime: 'audio/wav', data: WAV.toString('base64') });
    const missing = await send({ assetId: 9999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const invalid = await send({});
    assert.ok(invalid && !invalid.ok && invalid.error.kind === 'validation');
  } finally {
    database.close();
  }
});

test('数据变化通知，以及删除资产、集时绑定随之清除', () => {
  const { database, assets, service, episode1, guard } = createFixture();
  try {
    let count = 0;
    service.onDidChangeBindings(() => {
      count += 1;
    });
    const asset = assets.createAsset('character', { name: '甲' });
    const binding = service.bind({ episodeId: episode1, entityId: guard, assetId: asset.id });
    assert.throws(() => service.bind({ episodeId: episode1, entityId: guard, assetId: 9999 }));
    service.setPrimary(binding.id);
    assert.equal(count, 2);

    assets.deleteAsset(asset.id);
    assert.deepEqual(service.listBindings(episode1), []);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entity_bindings').get()?.n, 0);
  } finally {
    database.close();
  }
});

test('请求处理：列表、绑定、切换主资产、解除、自动匹配建议；错误按类型返回', async () => {
  const { database, assets, service, episode1, guard } = createFixture();
  try {
    const router = new MessageRouter();
    registerBindingHandlers(router, service);
    const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
    const first = assets.createAsset('character', { name: '守夜人' });
    const second = assets.createAsset('character', { name: '老陈' });

    const suggest = await send(BINDING_REQUESTS.suggest, { episodeId: episode1 });
    assert.equal((suggest?.ok && (suggest.data as { suggestions: unknown[] }).suggestions.length) || 0, 2);

    const bound = await send(BINDING_REQUESTS.bind, { episodeId: episode1, entityId: guard, assetId: first.id });
    assert.ok(bound?.ok);
    const secondBound = await send(BINDING_REQUESTS.bind, { episodeId: episode1, entityId: guard, assetId: second.id });
    assert.ok(secondBound?.ok);
    const secondId = (secondBound.data as { id: number }).id;

    const primary = await send(BINDING_REQUESTS.setPrimary, { id: secondId });
    assert.equal(primary?.ok && (primary.data as { isPrimary: boolean }).isPrimary, true);
    const listed = await send(BINDING_REQUESTS.list, { episodeId: episode1 });
    assert.equal(listed?.ok && (listed.data as { bindings: unknown[] }).bindings.length, 2);
    const unbound = await send(BINDING_REQUESTS.unbind, { id: secondId });
    assert.deepEqual(unbound?.ok && unbound.data, { unbound: true });

    const duplicate = await send(BINDING_REQUESTS.bind, { episodeId: episode1, entityId: guard, assetId: first.id });
    assert.ok(duplicate && !duplicate.ok && duplicate.error.kind === 'conflict');
    const missing = await send(BINDING_REQUESTS.unbind, { id: secondId });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const invalid = await send(BINDING_REQUESTS.list, {});
    assert.ok(invalid && !invalid.ok && invalid.error.kind === 'validation');
  } finally {
    database.close();
  }
});
