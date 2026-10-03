// ------------------------------------------------------------------------
// 名称：asset-service.test.ts
// 说明：资产应用服务（含资产规则与 SQLite 仓库）的自动化测试：创建、校验、重名、修改、音频、使用情况（绑定与镜头声音）、音色参考保护与删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库与真实的仓库；文件按提交格式（JSON 文本，Base64）构造。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { seedAssetUsage } from '../../infra/database/testing/seed-asset-usage';
import { AssetService } from './asset-service';
import { ProjectService } from './project-service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0]);

/** 创建服务、两个项目与内存数据库。 */
function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const service = new AssetService(new SqliteAssetRepository(database));
  const first = projects.createProject({ name: '项目甲' });
  const second = projects.createProject({ name: '项目乙' });
  return { database, projects, service, first, second };
}

/** 构造一个图片文件条目，带缩略图与宽高。 */
function imageItem(name: string, content: Buffer = PNG, extra: Record<string, unknown> = {}) {
  return {
    name,
    mimeType: 'image/png',
    size: content.length,
    data: content.toString('base64'),
    width: 640,
    height: 480,
    thumbnail: { mimeType: 'image/jpeg', data: THUMB.toString('base64') },
    ...extra
  };
}

/** 构造一个音频文件条目。 */
function audioItem(name: string, content: Buffer = WAV, durationSeconds: unknown = 12.345) {
  return { name, mimeType: 'audio/wav', size: content.length, data: content.toString('base64'), durationSeconds };
}

/** 把文件条目序列化为表单提交的文本。 */
function files(...items: object[]): string {
  return JSON.stringify(items);
}

test('创建图片类资产：保存描述字段、选项与文件，列表带缩略图与统计', () => {
  const { database, service } = createFixture();
  try {
    const asset = service.createAsset('character', {
      name: '林夏',
      characterType: '人类',
      appearance: '短发',
      voiceDescription: '',
      composition: '正面全身像',
      style: '',
      background: '纯白背景',
      referenceAspectRatio: '2:3',
      extra: '偏冷色调',
      files: files(imageItem('a.png'), imageItem('b.jpg', JPEG))
    });

    assert.equal(asset.kind, 'character');
    assert.equal(asset.name, '林夏');
    assert.deepEqual(asset.attributes, { character_type: '人类', appearance: '短发' });
    assert.deepEqual([asset.composition, asset.style, asset.background, asset.referenceAspectRatio], ['正面全身像', null, '纯白背景', '2:3']);
    assert.deepEqual([asset.extraRequirements, asset.promptZh, asset.promptEn], ['偏冷色调', '', '']);
    assert.equal(asset.sourceEntityId, null);

    const [item] = service.listAssets('character');
    assert.equal(item.id, asset.id);
    assert.equal(item.fileCount, 2);
    assert.equal(item.episodeCount, 0);
    assert.equal(item.durationSeconds, null);
    assert.equal(item.thumbnail?.mime, 'image/jpeg');
    assert.equal(item.thumbnail?.data, THUMB.toString('base64'));
    assert.deepEqual(service.listAssets('scene'), []);

    const references = service.getReferenceFiles(asset.id);
    assert.deepEqual(references.map((file) => [file.fileName, file.mime, file.width, file.height, file.sortOrder]), [
      ['a.png', 'image/png', 640, 480, 0],
      ['b.jpg', 'image/jpeg', 640, 480, 1]
    ]);
    assert.ok(references[0].content.equals(PNG));
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM asset_files WHERE role = 'thumbnail'").get()?.n, 2);
  } finally {
    database.close();
  }
});

test('提示词：创建与编辑表单都不含提示词，编辑保留已有提示词；手动保存提示词校验长度、生成中拒绝，保存即确认', () => {
  const { database, service } = createFixture();
  try {
    const asset = service.createAsset('prop', { name: '钥匙', appearance: '黄铜', promptZh: '会被忽略' });
    assert.deepEqual([asset.promptZh, asset.promptEn, asset.promptRevision, asset.promptContentRevision], ['', '', 0, 0]);

    const saved = service.updatePrompts(asset.id, { promptZh: ' 中文提示词 ', promptEn: 'english prompt' });
    assert.deepEqual([saved.promptZh, saved.promptEn, saved.promptRevision, saved.promptContentRevision, saved.promptStatus], ['中文提示词', 'english prompt', 1, 1, 'none']);

    // 编辑内容字段不会动提示词，表单字段变化后提示词需更新；手动保存（文本没变）即确认。
    const edited = service.updateAsset(asset.id, { name: '钥匙', appearance: '银质', promptZh: '被忽略' });
    assert.deepEqual([edited.promptZh, edited.promptEn, edited.contentRevision, edited.promptRevision, edited.promptContentRevision], ['中文提示词', 'english prompt', 2, 1, 1]);
    const confirmed = service.updatePrompts(asset.id, { promptZh: '中文提示词', promptEn: 'english prompt' });
    assert.deepEqual([confirmed.promptRevision, confirmed.promptContentRevision], [1, 2]);

    // 清空后不再有依据。
    const cleared = service.updatePrompts(asset.id, { promptZh: '', promptEn: '' });
    assert.deepEqual([cleared.promptRevision, cleared.promptContentRevision], [2, 0]);

    assert.throws(() => service.updatePrompts(asset.id, { promptZh: '长'.repeat(2001) }), (error) => error instanceof ValidationError && 'promptZh' in error.fieldErrors);
    database.prepare("UPDATE assets SET prompt_status = 'running' WHERE id = ?").run(asset.id);
    assert.throws(() => service.updatePrompts(asset.id, { promptZh: '新' }), (error) => error instanceof ValidationError && 'promptZh' in error.fieldErrors);
    assert.throws(() => service.updatePrompts(9999, {}), NotFoundError);
  } finally {
    database.close();
  }
});

test('创建：没有文件也可以；不合格的缩略图被忽略，不影响保存；宽高不合法时为空', () => {
  const { database, service } = createFixture();
  try {
    service.createAsset('prop', { name: '钥匙' });
    assert.equal(service.listAssets('prop')[0].fileCount, 0);

    const asset = service.createAsset('prop', {
      name: '怀表',
      files: files(imageItem('c.png', PNG, { thumbnail: { mimeType: 'image/jpeg', data: Buffer.from('not image').toString('base64') }, width: -1, height: 1.5 }))
    });
    const [reference] = service.getReferenceFiles(asset.id);
    assert.deepEqual([reference.width, reference.height], [null, null]);
    assert.equal(service.listAssets('prop').find((item) => item.id === asset.id)?.thumbnail, null);
  } finally {
    database.close();
  }
});

test('创建校验：名称、选项、文件内容的错误一并返回', () => {
  const { database, service } = createFixture();
  try {
    assert.throws(
      () =>
        service.createAsset('scene', {
          name: ' ',
          referenceAspectRatio: '5:7',
          placeType: 'x'.repeat(501),
          files: files({ name: 'x.png', mimeType: 'image/png', size: 3, data: Buffer.from('abc').toString('base64') })
        }),
      (error) =>
        error instanceof ValidationError &&
        ['name', 'referenceAspectRatio', 'placeType', 'files'].every((key) => error.fieldErrors[key] !== undefined)
    );
    assert.throws(
      () => service.createAsset('scene', { name: '灯塔', files: files(...Array.from({ length: 11 }, (_, index) => imageItem(`${index}.png`))) }),
      (error) => error instanceof ValidationError && /最多 10 张/.test(error.fieldErrors.files)
    );
    assert.throws(() => service.createAsset('scene', { name: '灯塔', files: 'not json' }), ValidationError);
    assert.equal(service.listAssets('scene').length, 0);
  } finally {
    database.close();
  }
});

test('重名：同类型全局拒绝，不同类型允许；检查接口排除自身', () => {
  const { database, service } = createFixture();
  try {
    const asset = service.createAsset('scene', { name: '灯塔' });
    assert.throws(
      () => service.createAsset('scene', { name: '灯塔' }),
      (error) => error instanceof ConflictError && error.field === 'name'
    );
    service.createAsset('prop', { name: '灯塔' });

    assert.equal(service.isNameAvailable('scene', '灯塔'), false);
    assert.equal(service.isNameAvailable('scene', '灯塔', asset.id), true);
    assert.equal(service.isNameAvailable('effect', '灯塔'), true);
  } finally {
    database.close();
  }
});

test('修改：更新内容并整体替换文件，类型不变，重名拒绝', () => {
  const { database, service } = createFixture();
  try {
    const asset = service.createAsset('character', { name: '林夏', style: '水彩插画', files: files(imageItem('a.png')) });
    service.createAsset('character', { name: '周远' });

    const updated = service.updateAsset(asset.id, {
      name: '林夏（雨天）',
      appearance: '披着雨衣',
      files: files(imageItem('b.jpg', JPEG), imageItem('c.png'))
    });
    assert.deepEqual([updated.kind, updated.name], ['character', '林夏（雨天）']);
    assert.deepEqual(updated.attributes, { appearance: '披着雨衣' });
    assert.equal(updated.style, null);
    assert.deepEqual(service.getReferenceFiles(asset.id).map((file) => file.fileName), ['b.jpg', 'c.png']);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM asset_files WHERE asset_id = ?").get(asset.id)?.n, 4);

    // 名称不变不算重名；改成其他资产的名称则拒绝，且不改动原有文件。
    service.updateAsset(asset.id, { name: '林夏（雨天）', files: files(imageItem('b.jpg', JPEG)) });
    assert.throws(() => service.updateAsset(asset.id, { name: '周远' }), ConflictError);
    assert.deepEqual(service.getReferenceFiles(asset.id).map((file) => file.fileName), ['b.jpg']);
    assert.throws(() => service.updateAsset(9999, { name: '甲' }), NotFoundError);
  } finally {
    database.close();
  }
});

test('音频资产：保存类型、描述、语言与时长；语言只对音色参考保留；文件可以暂时为空，有文件时按内容校验', () => {
  const { database, service } = createFixture();
  try {
    const voice = service.createAsset('audio', {
      name: '林夏的声音',
      audioKind: '音色参考',
      description: '清亮的女声',
      language: '中文',
      files: files(audioItem('v.wav'))
    });
    assert.deepEqual(voice.attributes, { audio_kind: 'voice', description: '清亮的女声', language: '中文' });
    assert.deepEqual([voice.composition, voice.style, voice.background, voice.referenceAspectRatio, voice.promptZh], ['', null, '', null, '']);

    const music = service.createAsset('audio', {
      name: '紧张配乐',
      audioKind: 'music',
      language: '英文',
      files: files(audioItem('m.mp3', MP3, 30))
    });
    assert.deepEqual(music.attributes, { audio_kind: 'music' });

    const [item] = service.listAssets('audio').filter((asset) => asset.id === voice.id);
    assert.equal(item.durationSeconds, 12.35);
    assert.equal(item.thumbnail, null);
    assert.equal(service.getReferenceFiles(voice.id)[0].mime, 'audio/wav');
    assert.equal(service.getReferenceFiles(music.id)[0].mime, 'audio/mpeg');

    const base = { name: '新音频', audioKind: 'sfx' };
    const errorOf = (extra: object) => {
      try {
        service.createAsset('audio', { ...base, ...extra });
      } catch (error) {
        return error instanceof ValidationError ? error.fieldErrors : undefined;
      }
      return undefined;
    };
    assert.deepEqual(errorOf({}), undefined, '音频文件可以暂时没有，之后上传或由模型生成');
    assert.ok(errorOf({ audioKind: '', files: files(audioItem('a.wav')) })?.audioKind);
    assert.match(errorOf({ files: files(audioItem('a.wav', WAV, 61)) })?.files ?? '', /超过 60 秒/);
    assert.match(errorOf({ files: files(audioItem('a.wav', WAV, null)) })?.files ?? '', /无法读取/);
    assert.match(errorOf({ files: files(audioItem('a.wav', Buffer.from('plain text'))) })?.files ?? '', /不是有效的/);
    assert.match(errorOf({ files: files(audioItem('a.ogg', WAV)) })?.files ?? '', /只支持/);
    assert.match(errorOf({ name: '另一个', files: files(audioItem('a.wav'), audioItem('b.wav')) })?.files ?? '', /1 个音频文件/);
  } finally {
    database.close();
  }
});

test('使用情况与删除：被绑定的音频不能改类型；删除资产连同文件和绑定，提示被哪些集使用', () => {
  const { database, service, first } = createFixture();
  try {
    const asset = service.createAsset('audio', { name: '音色', audioKind: 'voice', files: files(audioItem('v.wav')) });
    const work = database
      .prepare("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'series', 't', 't')")
      .run(first.id);
    const episode = database
      .prepare("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 2, '雨夜', 't', 't')")
      .run(Number(work.lastInsertRowid));
    const entity = database
      .prepare("INSERT INTO script_entities (work_id, kind, name, created_at, updated_at) VALUES (?, 'character', '林夏', 't', 't')")
      .run(Number(work.lastInsertRowid));
    database
      .prepare("INSERT INTO entity_bindings (episode_id, entity_id, asset_id, purpose, created_at) VALUES (?, ?, ?, 'voice', 't')")
      .run(Number(episode.lastInsertRowid), Number(entity.lastInsertRowid), asset.id);

    assert.equal(service.listAssets('audio')[0].episodeCount, 1);
    const impact = service.getDeletionImpact(asset.id);
    assert.equal(impact.name, '音色');
    assert.deepEqual(impact.usage.bindings, [{ workName: '作品甲', episodeSeq: 2, episodeTitle: '雨夜', entityName: '林夏' }]);

    assert.throws(
      () => service.updateAsset(asset.id, { name: '音色', audioKind: 'music', files: files(audioItem('v.wav')) }),
      (error) => error instanceof ValidationError && error.fieldErrors.audioKind !== undefined
    );
    service.updateAsset(asset.id, { name: '音色', audioKind: 'voice', description: '改了描述', files: files(audioItem('v.wav')) });

    service.deleteAsset(asset.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM asset_files').get()?.n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM entity_bindings').get()?.n, 0);
    assert.throws(() => service.deleteAsset(asset.id), NotFoundError);
    assert.throws(() => service.getDeletionImpact(asset.id), NotFoundError);
  } finally {
    database.close();
  }
});

test('被用作音色参考的音频不能清空文件：提示被几个角色使用；替换文件或解除绑定后可以；只被镜头声音引用的不受限', () => {
  const { database, service, first } = createFixture();
  try {
    const voice = service.createAsset('audio', { name: '音色', audioKind: 'voice', files: files(audioItem('v.wav')) });
    const seed = seedAssetUsage(database, first.id);
    seed.bindEntity(voice.id, 0, 0, 'voice');
    seed.bindEntity(voice.id, 0, 1, 'voice');
    const form = { name: '音色', audioKind: 'voice' };

    assert.equal(service.getDeletionImpact(voice.id).usage.voiceBindingCount, 2);
    assert.throws(
      () => service.updateAsset(voice.id, { ...form, files: files() }),
      (error) => error instanceof ValidationError && error.fieldErrors.files === '该音频已被 2 个角色用作音色参考，请先解除绑定或替换文件。'
    );
    assert.throws(() => service.updateAsset(voice.id, form), ValidationError, '不提交文件同样是清空');
    assert.equal(service.getReferenceFiles(voice.id).length, 1, '被拒绝后文件保持不变');

    // 替换文件不受限；改描述并保留文件也不受限。
    service.updateAsset(voice.id, { ...form, files: files(audioItem('new.wav', WAV, 5)) });
    assert.equal(service.getReferenceFiles(voice.id)[0].fileName, 'new.wav');
    service.updateAsset(voice.id, { ...form, description: '改了描述', files: files(audioItem('new.wav', WAV, 5)) });

    // 解除绑定后可以清空。
    database.prepare('DELETE FROM entity_bindings').run();
    assert.equal(service.updateAsset(voice.id, { ...form, files: files() }).id, voice.id);
    assert.equal(service.getReferenceFiles(voice.id).length, 0);

    // 只被镜头声音引用的音频（不是音色参考绑定）可以清空文件。
    const music = service.createAsset('audio', { name: '配乐', audioKind: 'music', files: files(audioItem('m.mp3', MP3, 30)) });
    seed.addSounds(music.id, 0);
    service.updateAsset(music.id, { name: '配乐', audioKind: 'music', files: files() });
    assert.equal(service.getReferenceFiles(music.id).length, 0);
  } finally {
    database.close();
  }
});

test('使用情况含镜头声音直接指定的音频：按集汇总条数，列表的“使用集数”与绑定所在的集合并去重', () => {
  const { database, service, first } = createFixture();
  try {
    const music = service.createAsset('audio', { name: '配乐', audioKind: 'music', files: files(audioItem('m.mp3', MP3, 30)) });
    assert.equal(service.listAssets('audio')[0].episodeCount, 0);
    assert.deepEqual(service.getDeletionImpact(music.id).usage, { bindings: [], soundReferences: 0, soundEpisodes: [], voiceBindingCount: 0 });

    const seed = seedAssetUsage(database, first.id, 3);
    seed.addSounds(music.id, 0, 2);
    seed.addSounds(music.id, 2, 1);
    assert.equal(service.listAssets('audio')[0].episodeCount, 2, '只有镜头声音引用时也算被使用');
    const usage = service.getDeletionImpact(music.id).usage;
    assert.deepEqual(usage.soundEpisodes, [
      { workName: '作品甲', episodeSeq: 1, episodeTitle: '第1集标题', soundCount: 2 },
      { workName: '作品甲', episodeSeq: 3, episodeTitle: '第3集标题', soundCount: 1 }
    ]);
    assert.equal(usage.soundReferences, 3);
    assert.equal(usage.bindings.length, 0);

    // 同一集既有绑定又有声音引用只算一集；另一集的绑定再加一集。
    seed.bindEntity(music.id, 0, 0, 'visual');
    assert.equal(service.listAssets('audio')[0].episodeCount, 2);
    seed.bindEntity(music.id, 1, 0, 'visual');
    assert.equal(service.listAssets('audio')[0].episodeCount, 3);

    // 删除资产后，镜头声音的引用被置空。
    service.deleteAsset(music.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM shot_sounds WHERE audio_asset_id IS NOT NULL').get()?.n, 0);
  } finally {
    database.close();
  }
});

test('数据变化通知：成功的写操作通知，失败的不通知', () => {
  const { database, service } = createFixture();
  try {
    let count = 0;
    const unsubscribe = service.onDidChangeAssets(() => {
      count += 1;
    });
    const asset = service.createAsset('effect', { name: '火花' });
    service.updateAsset(asset.id, { name: '火花二' });
    assert.throws(() => service.createAsset('effect', { name: '' }));
    service.deleteAsset(asset.id);
    assert.equal(count, 3);
    unsubscribe();
    service.createAsset('effect', { name: '烟雾' });
    assert.equal(count, 3);
  } finally {
    database.close();
  }
});

test('删除项目不影响资产；来源实体随作品删除后资产保留、来源清空', () => {
  const { database, projects, service, first } = createFixture();
  try {
    const insert = (sql: string, ...params: Array<string | number>) => Number(database.prepare(sql).run(...params).lastInsertRowid);
    const work = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'single', 't', 't')", first.id);
    const entity = insert("INSERT INTO script_entities (work_id, kind, name, created_at, updated_at) VALUES (?, 'character', '林夏', 't', 't')", work);
    const asset = service.createAsset('character', { name: '林夏', files: files(imageItem('a.png')) }, { sourceEntityId: entity });
    assert.equal(asset.sourceEntityId, entity);

    projects.deleteProject(first.id);
    const [kept] = service.listAssets('character');
    assert.deepEqual([kept.id, kept.sourceEntityId, kept.fileCount], [asset.id, null, 1]);
  } finally {
    database.close();
  }
});
