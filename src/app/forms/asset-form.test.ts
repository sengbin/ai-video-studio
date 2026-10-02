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
import { ConflictError, NotFoundError, TextGenerationError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteBindingRepository } from '../../infra/database/sqlite-binding-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService, DUPLICATE_ASSET_NAME_MESSAGE } from '../services/asset-service';
import { BindingService } from '../services/binding-service';
import { ProjectService } from '../services/project-service';
import { FILE_PROMPTS, ScriptedText } from '../stages/testing/scripted-text';
import { ASSET_FORM_NAMES, createAssetFormCatalog } from './asset-form';
import { FormDefinition } from './form-definition';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);

function createFixture(projectNames: readonly string[] = ['项目甲', '项目乙']) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assetRepository = new SqliteAssetRepository(database);
  const assets = new AssetService(assetRepository, projects);
  const created = projectNames.map((name) => projects.createProject({ name }));
  const text = new ScriptedText(() => ({ promptZh: '中文提示词', promptEn: 'english prompt' }));
  const prompts = new AssetPromptService({ text, prompts: FILE_PROMPTS, projects });
  const bindings = new BindingService(new SqliteBindingRepository(database), assetRepository);
  const catalog = createAssetFormCatalog({ projects, assets, prompts, entities: bindings });
  const open = (name: string, params: unknown): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { database, projects, assets, bindings, text, created, open };
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

test('生成提示词动作：图像类资产有，音频没有；用表单草稿、参考图和项目风格调用模型并回填中英文提示词', async () => {
  const { database, projects, text, created, open } = createFixture();
  try {
    projects.updateProject(created[0].id, { name: '项目甲', visualStyle: '写实摄影' });
    assert.deepEqual(open(ASSET_FORM_NAMES.create, { kind: 'audio' }).schema.actions, []);
    assert.equal(open(ASSET_FORM_NAMES.create, { kind: 'audio' }).actions, undefined);

    const form = open(ASSET_FORM_NAMES.create, { kind: 'character', projectId: created[0].id });
    assert.deepEqual(form.schema.actions, [
      { key: 'generatePrompt', label: '生成提示词', before: 'promptZh', fills: ['promptZh', 'promptEn'], imageField: 'files', maxImages: 3 }
    ]);
    const image = { name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64') };
    const result = await form.actions?.generatePrompt(
      { projectName: '项目甲', name: '林夏', appearance: '短发', files: JSON.stringify([image]) },
      new AbortController().signal
    );
    assert.deepEqual(result, { promptZh: '中文提示词', promptEn: 'english prompt' });
    const [request] = text.requests;
    assert.match(request.user, /角色名称：林夏/);
    assert.match(request.user, /角色外观：短发/);
    assert.match(request.user, /画面风格（沿用项目风格）：写实摄影/);
    assert.equal(request.images?.length, 1);
    assert.equal(request.tool.name, 'submit_asset_prompts');
  } finally {
    database.close();
  }
});

test('生成提示词动作：信息不足、参考图无效时报错，取消时终止', async () => {
  const { database, open } = createFixture();
  try {
    const { generatePrompt } = open(ASSET_FORM_NAMES.create, { kind: 'prop' }).actions ?? {};
    const signal = new AbortController().signal;
    await assert.rejects(generatePrompt({ name: '钥匙' }, signal), (error) => error instanceof ValidationError && /至少填写一项描述/.test(error.message));
    await assert.rejects(generatePrompt({ appearance: '黄铜' }, signal), ValidationError);
    const notImage = JSON.stringify([{ name: 'x.png', mimeType: 'image/png', size: 3, data: Buffer.from('abc').toString('base64') }]);
    await assert.rejects(generatePrompt({ name: '钥匙', files: notImage }, signal), (error) => error instanceof ValidationError && error.fieldErrors.files !== undefined);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(generatePrompt({ name: '钥匙', appearance: '黄铜' }, controller.signal), (error) => error instanceof TextGenerationError && error.category === 'canceled');
  } finally {
    database.close();
  }
});

test('生成提示词动作：模型输出不合格时给出文本生成错误', async () => {
  const { database, text, open } = createFixture();
  try {
    const bad = new ScriptedText(() => ({ promptZh: '', promptEn: 'only english' }));
    Object.assign(text, { generate: bad.generate.bind(bad) });
    const { generatePrompt } = open(ASSET_FORM_NAMES.create, { kind: 'prop' }).actions ?? {};
    await assert.rejects(
      generatePrompt({ name: '钥匙', appearance: '黄铜' }, new AbortController().signal),
      (error) => error instanceof TextGenerationError && /中文提示词不能为空/.test(error.message)
    );
  } finally {
    database.close();
  }
});

/** 在项目甲下写入作品、集和一个带设定的角色实体。 */
function seedEntity(database: ReturnType<typeof openDatabase>, projectId: number) {
  const insert = (sql: string, ...params: Array<string | number>) => Number(database.prepare(sql).run(...params).lastInsertRowid);
  const work = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'single', 't', 't')", projectId);
  const episode = insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, '第一集', 't', 't')", work);
  const entity = insert(
    `INSERT INTO script_entities (work_id, kind, name, description, attributes_json, created_at, updated_at)
     VALUES (?, 'character', '守夜人', '灯塔守护者', ?, 't', 't')`,
    work,
    JSON.stringify({ appearance: '花白胡须', outfit: '深蓝雨衣', voice: '低沉沙哑', identity: '守塔四十年' })
  );
  return { episode, entity };
}

test('从实体新建：按设定预填，项目固定为作品所在项目，保存后记录来源并绑定为形象', async () => {
  const { database, assets, bindings, created, open } = createFixture();
  try {
    const { episode, entity } = seedEntity(database, created[1].id);
    const form = open(ASSET_FORM_NAMES.create, { episodeId: episode, entityId: entity });
    assert.equal(form.schema.title, '新建角色');
    assert.deepEqual(form.schema.fields.find((field) => field.key === 'projectName')?.options, ['项目乙']);
    assert.deepEqual(form.initialValues, {
      projectName: '项目乙',
      name: '守夜人',
      appearance: '花白胡须',
      clothing: '深蓝雨衣',
      voiceDescription: '低沉沙哑',
      extra: '设定概述：灯塔守护者\n身份与目标：守塔四十年'
    });

    await submit(form, { ...form.initialValues });
    const [asset] = assets.listAssets('character');
    assert.deepEqual([asset.name, asset.projectId, asset.sourceEntityId], ['守夜人', created[1].id, entity]);
    assert.deepEqual(
      bindings.listBindings(episode).map((binding) => [binding.entityId, binding.assetId, binding.purpose, binding.isPrimary]),
      [[entity, asset.id, 'visual', true]]
    );
  } finally {
    database.close();
  }
});

test('从实体新建：绑定失败时不留下新资产；实体不存在或标识无效时打不开', async () => {
  const { database, assets, created, open } = createFixture();
  try {
    const { episode, entity } = seedEntity(database, created[0].id);
    const form = open(ASSET_FORM_NAMES.create, { episodeId: episode, entityId: entity });
    // 实体在打开表单后被删除：绑定会失败，新建的资产要回滚。
    database.prepare('DELETE FROM script_entities WHERE id = ?').run(entity);
    await assert.rejects(submit(form, { ...form.initialValues }));
    assert.equal(assets.listAssets('character').length, 0);

    assert.throws(() => open(ASSET_FORM_NAMES.create, { episodeId: episode, entityId: entity }), NotFoundError);
    assert.throws(() => open(ASSET_FORM_NAMES.create, { episodeId: 'x', entityId: entity }), ValidationError);
  } finally {
    database.close();
  }
});
