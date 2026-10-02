// ------------------------------------------------------------------------
// 名称：asset-form.test.ts
// 说明：资产表单的自动化测试：字段随类型变化、所属项目与默认值、提交创建与修改、编辑时带出已有文件与重名检查。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库与真实的服务。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { AssetService, DUPLICATE_ASSET_NAME_MESSAGE } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { ASSET_FORM_NAMES, createAssetFormCatalog } from './asset-form';
import { FormDefinition } from './form-definition';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);

function createFixture(projectNames: readonly string[] = ['项目甲', '项目乙']) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assets = new AssetService(new SqliteAssetRepository(database), projects);
  const created = projectNames.map((name) => projects.createProject({ name }));
  const catalog = createAssetFormCatalog({ projects, assets });
  const open = (name: string, params: unknown): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { database, projects, assets, created, open };
}

/** 提交并等待完成，供 assert.rejects 使用。 */
async function submit(form: FormDefinition, values: Record<string, string>): Promise<void> {
  await form.submit(values);
}

test('新建表单：字段随类型变化，文件字段按类型限制，音频默认选中“音色参考”', () => {
  const { database, open } = createFixture();
  try {
    const keysOf = (kind: string) => open(ASSET_FORM_NAMES.create, { kind }).schema.fields.map((field) => field.key);
    assert.deepEqual(keysOf('character'), [
      'projectName', 'name', 'composition', 'style', 'background', 'referenceAspectRatio',
      'characterType', 'appearance', 'clothing', 'expressionPose', 'voiceDescription', 'extra', 'promptZh', 'promptEn', 'files'
    ]);
    assert.deepEqual(keysOf('prop'), [
      'projectName', 'name', 'composition', 'style', 'background', 'referenceAspectRatio', 'appearance', 'state', 'extra', 'promptZh', 'promptEn', 'files'
    ]);
    assert.deepEqual(keysOf('audio'), ['projectName', 'name', 'audioKind', 'description', 'language', 'files', 'extra']);

    const image = open(ASSET_FORM_NAMES.create, { kind: 'scene' });
    assert.equal(image.schema.title, '新建场景');
    const imageFiles = image.schema.fields.find((field) => field.key === 'files');
    assert.deepEqual([imageFiles?.multiple, imageFiles?.preview, imageFiles?.derive, imageFiles?.required], [true, 'image', 'image', false]);
    assert.ok(image.schema.fields.find((field) => field.key === 'composition')?.options?.includes('平视广角全景'));

    const audio = open(ASSET_FORM_NAMES.create, { kind: 'audio' });
    const audioFiles = audio.schema.fields.find((field) => field.key === 'files');
    assert.deepEqual([audioFiles?.multiple, audioFiles?.derive, audioFiles?.required], [false, 'audio', true]);
    assert.deepEqual(audio.schema.fields.find((field) => field.key === 'audioKind')?.options, ['音色参考', '背景音乐', '音效']);
    assert.equal(audio.initialValues.audioKind, '音色参考');
    assert.equal(audio.checkField, undefined, '所属项目可能还没选，重名只在提交时检查');
  } finally {
    database.close();
  }
});

test('新建表单：入口传默认项目则预选；只有一个项目时自动选中；没有项目或类型无效时打不开', () => {
  const { database, created, open } = createFixture();
  try {
    assert.equal(open(ASSET_FORM_NAMES.create, { kind: 'prop' }).initialValues.projectName, undefined);
    assert.equal(open(ASSET_FORM_NAMES.create, { kind: 'prop', projectId: created[1].id }).initialValues.projectName, '项目乙');
    assert.throws(() => open(ASSET_FORM_NAMES.create, { kind: 'bogus' }), ValidationError);
    assert.throws(() => open(ASSET_FORM_NAMES.create, undefined), ValidationError);
  } finally {
    database.close();
  }

  const single = createFixture(['唯一项目']);
  try {
    assert.equal(single.open(ASSET_FORM_NAMES.create, { kind: 'prop' }).initialValues.projectName, '唯一项目');
  } finally {
    single.database.close();
  }

  const empty = createFixture([]);
  try {
    assert.throws(() => empty.open(ASSET_FORM_NAMES.create, { kind: 'prop' }), (error) => error instanceof ValidationError && /还没有项目/.test(error.message));
  } finally {
    empty.database.close();
  }
});

test('提交新建：创建资产；缺少项目与重名分别给出字段错误', async () => {
  const { database, assets, open } = createFixture();
  try {
    const form = open(ASSET_FORM_NAMES.create, { kind: 'prop' });
    await submit(form, { projectName: '项目甲', name: '钥匙', appearance: '黄铜' });
    const [item] = assets.listAssets('prop');
    assert.deepEqual([item.name, item.attributes], ['钥匙', { appearance: '黄铜' }]);

    await assert.rejects(submit(form, { projectName: '项目甲', name: '钥匙' }), ConflictError);
    await assert.rejects(submit(form, { name: '怀表' }), (error) => error instanceof ValidationError && error.fieldErrors.projectName !== undefined);
  } finally {
    database.close();
  }
});

test('编辑表单：不含所属项目，带出已有内容与文件，重名检查排除自身，提交修改并替换文件', async () => {
  const { database, assets, open } = createFixture();
  try {
    const file = { name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), width: 10, height: 10 };
    const asset = assets.createAsset('character', {
      projectName: '项目甲',
      name: '林夏',
      characterType: '人类',
      style: '水彩插画',
      referenceAspectRatio: '1:1',
      promptZh: '提示词',
      files: JSON.stringify([file])
    });
    assets.createAsset('character', { projectName: '项目甲', name: '周远' });

    const form = open(ASSET_FORM_NAMES.edit, { assetId: asset.id });
    assert.equal(form.schema.title, '编辑角色');
    assert.ok(!form.schema.fields.some((field) => field.key === 'projectName'));
    assert.equal(form.schema.fields.find((field) => field.key === 'name')?.checkUnique, true);
    assert.deepEqual(
      [form.initialValues.name, form.initialValues.characterType, form.initialValues.style, form.initialValues.referenceAspectRatio, form.initialValues.promptZh],
      ['林夏', '人类', '水彩插画', '1:1', '提示词']
    );
    assert.deepEqual(JSON.parse(form.initialValues.files), [{ name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64') }]);

    assert.equal(form.checkField?.('name', '周远'), DUPLICATE_ASSET_NAME_MESSAGE);
    assert.equal(form.checkField?.('name', '林夏'), undefined);
    assert.equal(form.checkField?.('name', '新名字'), undefined);

    await submit(form, { ...form.initialValues, name: '林夏二', files: '[]' });
    assert.equal(assets.getAsset(asset.id).name, '林夏二');
    assert.equal(assets.getReferenceFiles(asset.id).length, 0);
    assert.throws(() => open(ASSET_FORM_NAMES.edit, { assetId: 9999 }), NotFoundError);
    assert.throws(() => open(ASSET_FORM_NAMES.edit, {}), ValidationError);
  } finally {
    database.close();
  }
});

test('编辑音频：初始值使用界面文字，已有音频随表单带出', () => {
  const { database, assets, open } = createFixture();
  try {
    const audio = assets.createAsset('audio', {
      projectName: '项目甲',
      name: '配乐',
      audioKind: '背景音乐',
      description: '紧张',
      files: JSON.stringify([{ name: 'm.wav', mimeType: 'audio/wav', size: WAV.length, data: WAV.toString('base64'), durationSeconds: 5 }])
    });
    const form = open(ASSET_FORM_NAMES.edit, { assetId: audio.id });
    assert.deepEqual([form.initialValues.audioKind, form.initialValues.description, form.initialValues.language], ['背景音乐', '紧张', '']);
    assert.equal((JSON.parse(form.initialValues.files) as unknown[]).length, 1);
  } finally {
    database.close();
  }
});
