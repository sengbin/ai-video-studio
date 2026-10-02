// ------------------------------------------------------------------------
// 名称：asset-service.test.ts
// 说明：资产应用服务（含资产规则与 SQLite 仓库）的自动化测试：创建、校验、重名、修改、音频、使用情况与删除。
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
  const service = new AssetService(new SqliteAssetRepository(database), projects);
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
      projectName: '项目甲',
      name: '林夏',
      characterType: '人类',
      appearance: '短发',
      voiceDescription: '',
      composition: '正面全身像',
      style: '',
      background: '纯白背景',
      referenceAspectRatio: '2:3',
      extra: '偏冷色调',
      promptZh: '中文提示词',
      promptEn: 'english prompt',
      files: files(imageItem('a.png'), imageItem('b.jpg', JPEG))
    });

    assert.equal(asset.kind, 'character');
    assert.equal(asset.name, '林夏');
    assert.deepEqual(asset.attributes, { character_type: '人类', appearance: '短发' });
    assert.deepEqual([asset.composition, asset.style, asset.background, asset.referenceAspectRatio], ['正面全身像', null, '纯白背景', '2:3']);
    assert.deepEqual([asset.extraRequirements, asset.promptZh, asset.promptEn], ['偏冷色调', '中文提示词', 'english prompt']);
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

test('创建：没有文件也可以；不合格的缩略图被忽略，不影响保存；宽高不合法时为空', () => {
  const { database, service } = createFixture();
  try {
    service.createAsset('prop', { projectName: '项目甲', name: '钥匙' });
    assert.equal(service.listAssets('prop')[0].fileCount, 0);

    const asset = service.createAsset('prop', {
      projectName: '项目甲',
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

test('创建校验：名称、项目、选项、文件内容的错误一并返回', () => {
  const { database, service } = createFixture();
  try {
    assert.throws(
      () =>
        service.createAsset('scene', {
          projectName: '不存在的项目',
          name: ' ',
          referenceAspectRatio: '5:7',
          placeType: 'x'.repeat(501),
          files: files({ name: 'x.png', mimeType: 'image/png', size: 3, data: Buffer.from('abc').toString('base64') })
        }),
      (error) =>
        error instanceof ValidationError &&
        ['projectName', 'name', 'referenceAspectRatio', 'placeType', 'files'].every((key) => error.fieldErrors[key] !== undefined)
    );
    assert.throws(
      () => service.createAsset('scene', { projectName: '项目甲', name: '灯塔', files: files(...Array.from({ length: 11 }, (_, index) => imageItem(`${index}.png`))) }),
      (error) => error instanceof ValidationError && /最多 10 张/.test(error.fieldErrors.files)
    );
    assert.throws(() => service.createAsset('scene', { projectName: '项目甲', name: '灯塔', files: 'not json' }), ValidationError);
    assert.equal(service.listAssets('scene').length, 0);
  } finally {
    database.close();
  }
});

test('重名：同项目同类型拒绝，不同项目或不同类型允许；检查接口排除自身', () => {
  const { database, service, first, second } = createFixture();
  try {
    const asset = service.createAsset('scene', { projectName: '项目甲', name: '灯塔' });
    assert.throws(
      () => service.createAsset('scene', { projectName: '项目甲', name: '灯塔' }),
      (error) => error instanceof ConflictError && error.field === 'name'
    );
    service.createAsset('scene', { projectName: '项目乙', name: '灯塔' });
    service.createAsset('prop', { projectName: '项目甲', name: '灯塔' });

    assert.equal(service.isNameAvailable(first.id, 'scene', '灯塔'), false);
    assert.equal(service.isNameAvailable(first.id, 'scene', '灯塔', asset.id), true);
    assert.equal(service.isNameAvailable(second.id, 'effect', '灯塔'), true);
  } finally {
    database.close();
  }
});

test('修改：更新内容并整体替换文件，所属项目与类型不变，重名拒绝', () => {
  const { database, service, first } = createFixture();
  try {
    const asset = service.createAsset('character', { projectName: '项目甲', name: '林夏', style: '水彩插画', files: files(imageItem('a.png')) });
    service.createAsset('character', { projectName: '项目甲', name: '周远' });

    const updated = service.updateAsset(asset.id, {
      projectName: '项目乙',
      name: '林夏（雨天）',
      appearance: '披着雨衣',
      files: files(imageItem('b.jpg', JPEG), imageItem('c.png'))
    });
    assert.deepEqual([updated.projectId, updated.kind, updated.name], [first.id, 'character', '林夏（雨天）']);
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

test('音频资产：保存类型、描述、语言与时长；语言只对音色参考保留；文件必填且按内容校验', () => {
  const { database, service } = createFixture();
  try {
    const voice = service.createAsset('audio', {
      projectName: '项目甲',
      name: '林夏的声音',
      audioKind: '音色参考',
      description: '清亮的女声',
      language: '中文',
      files: files(audioItem('v.wav'))
    });
    assert.deepEqual(voice.attributes, { audio_kind: 'voice', description: '清亮的女声', language: '中文' });
    assert.deepEqual([voice.composition, voice.style, voice.background, voice.referenceAspectRatio, voice.promptZh], ['', null, '', null, '']);

    const music = service.createAsset('audio', {
      projectName: '项目甲',
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

    const base = { projectName: '项目甲', name: '新音频', audioKind: 'sfx' };
    const errorOf = (extra: object) => {
      try {
        service.createAsset('audio', { ...base, ...extra });
      } catch (error) {
        return error instanceof ValidationError ? error.fieldErrors : undefined;
      }
      return undefined;
    };
    assert.ok(errorOf({})?.files, '音频文件必填');
    assert.ok(errorOf({ audioKind: '', files: files(audioItem('a.wav')) })?.audioKind);
    assert.match(errorOf({ files: files(audioItem('a.wav', WAV, 61)) })?.files ?? '', /超过 60 秒/);
    assert.match(errorOf({ files: files(audioItem('a.wav', WAV, null)) })?.files ?? '', /无法读取/);
    assert.match(errorOf({ files: files(audioItem('a.wav', Buffer.from('plain text'))) })?.files ?? '', /不是有效的/);
    assert.match(errorOf({ files: files(audioItem('a.ogg', WAV)) })?.files ?? '', /只支持/);
    assert.match(errorOf({ files: files(audioItem('a.wav'), audioItem('b.wav')) })?.files ?? '', /1 个音频文件/);
  } finally {
    database.close();
  }
});

test('使用情况与删除：被绑定的音频不能改类型；删除资产连同文件和绑定，提示被哪些集使用', () => {
  const { database, service, first } = createFixture();
  try {
    const asset = service.createAsset('audio', { projectName: '项目甲', name: '音色', audioKind: 'voice', files: files(audioItem('v.wav')) });
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

test('数据变化通知：成功的写操作通知，失败的不通知', () => {
  const { database, service } = createFixture();
  try {
    let count = 0;
    const unsubscribe = service.onDidChangeAssets(() => {
      count += 1;
    });
    const asset = service.createAsset('effect', { projectName: '项目甲', name: '火花' });
    service.updateAsset(asset.id, { name: '火花二' });
    assert.throws(() => service.createAsset('effect', { projectName: '项目甲', name: '' }));
    service.deleteAsset(asset.id);
    assert.equal(count, 3);
    unsubscribe();
    service.createAsset('effect', { projectName: '项目甲', name: '烟雾' });
    assert.equal(count, 3);
  } finally {
    database.close();
  }
});

test('删除项目时级联删除资产与文件；来源实体删除后资产保留', () => {
  const { database, projects, service, first } = createFixture();
  try {
    service.createAsset('character', { projectName: '项目甲', name: '林夏', files: files(imageItem('a.png')) });
    projects.deleteProject(first.id);
    assert.equal(service.listAssets('character').length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM asset_files').get()?.n, 0);
  } finally {
    database.close();
  }
});
