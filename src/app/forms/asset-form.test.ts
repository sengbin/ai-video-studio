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

function createFixture(projectNames: readonly string[] = ['项目甲', '项目乙'], responder?: () => unknown) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assetRepository = new SqliteAssetRepository(database);
  const assets = new AssetService(assetRepository, projects);
  const created = projectNames.map((name) => projects.createProject({ name }));
  const text = new ScriptedText(responder ?? (() => ({ promptZh: '中文提示词', promptEn: 'english prompt' })));
  const notifications: number[] = [];
  const prompts = new AssetPromptService({
    text,
    prompts: FILE_PROMPTS,
    projects,
    assets: assetRepository,
    notify: () => notifications.push(1)
  });
  const bindings = new BindingService(new SqliteBindingRepository(database), assetRepository);
  const catalog = createAssetFormCatalog({ projects, assets, prompts, entities: bindings });
  const open = (name: string, params: unknown): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { database, projects, assets, prompts, bindings, text, notifications, created, open };
}

/** 提交并等待完成，供 assert.rejects 使用。 */
async function submit(form: FormDefinition, values: Record<string, string>, submitKey?: string): Promise<void> {
  await form.submit(values, submitKey);
}

/** 等后台提示词任务结束（状态不再是生成中）。 */
async function waitForPrompt(assets: AssetService, id: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (assets.getAsset(id).promptStatus !== 'running') {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('提示词生成没有结束。');
}

test('新建表单：字段随类型变化，文件字段按类型限制，音频默认选中“音色参考”', () => {
  const { database, open } = createFixture();
  try {
    const keysOf = (kind: string) => open(ASSET_FORM_NAMES.create, { kind }).schema.fields.map((field) => field.key);
    assert.deepEqual(keysOf('character'), [
      'projectName', 'name', 'composition', 'style', 'background', 'referenceAspectRatio',
      'characterType', 'appearance', 'clothing', 'expressionPose', 'voiceDescription', 'extra', 'files'
    ]);
    assert.deepEqual(keysOf('prop'), [
      'projectName', 'name', 'composition', 'style', 'background', 'referenceAspectRatio', 'appearance', 'state', 'extra', 'files'
    ]);
    assert.deepEqual(keysOf('audio'), ['projectName', 'name', 'audioKind', 'description', 'language', 'extra', 'files']);

    const image = open(ASSET_FORM_NAMES.create, { kind: 'scene' });
    assert.equal(image.schema.title, '新建场景');
    const imageFiles = image.schema.fields.find((field) => field.key === 'files');
    assert.deepEqual([imageFiles?.multiple, imageFiles?.preview, imageFiles?.derive, imageFiles?.required], [true, 'image', 'image', false]);
    assert.ok(image.schema.fields.find((field) => field.key === 'composition')?.options?.includes('平视广角全景'));

    const audio = open(ASSET_FORM_NAMES.create, { kind: 'audio' });
    const audioFiles = audio.schema.fields.find((field) => field.key === 'files');
    assert.deepEqual([audioFiles?.multiple, audioFiles?.derive, audioFiles?.required], [false, 'audio', false]);
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
      files: JSON.stringify([file])
    });
    assets.createAsset('character', { projectName: '项目甲', name: '周远' });

    const form = open(ASSET_FORM_NAMES.edit, { assetId: asset.id });
    assert.equal(form.schema.title, '编辑角色');
    assert.ok(!form.schema.fields.some((field) => field.key === 'projectName'));
    assert.equal(form.schema.fields.find((field) => field.key === 'name')?.checkUnique, true);
    assert.deepEqual(
      [form.initialValues.name, form.initialValues.characterType, form.initialValues.style, form.initialValues.referenceAspectRatio, form.initialValues.promptZh],
      ['林夏', '人类', '水彩插画', '1:1', undefined]
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

test('提交按钮：新建与编辑表单各有两个按钮，主按钮生成提示词；编辑的主按钮要求覆盖确认；表单里没有字段动作', () => {
  const { database, assets, created, open } = createFixture();
  try {
    const form = open(ASSET_FORM_NAMES.create, { kind: 'character' });
    assert.deepEqual(form.schema.submitActions, [
      { key: 'create', label: '仅创建' },
      { key: 'createAndPrompt', label: '创建并生成提示词', primary: true }
    ]);
    assert.equal(form.actions, undefined);
    assert.equal(form.schema.actions, undefined);

    const asset = assets.createAsset('character', { projectName: '项目甲', name: '林夏' });
    const edit = open(ASSET_FORM_NAMES.edit, { assetId: asset.id });
    const [save, regenerate] = edit.schema.submitActions ?? [];
    assert.deepEqual([save.key, regenerate.key, regenerate.primary], ['save', 'saveAndPrompt', true]);
    assert.equal(regenerate.confirmOverwrite, undefined, '没有提示词时不需要覆盖确认');
    assets.updatePrompts(asset.id, { promptZh: '已有提示词' });
    const withPrompt = open(ASSET_FORM_NAMES.edit, { assetId: asset.id }).schema.submitActions ?? [];
    assert.deepEqual(withPrompt[1].confirmOverwrite?.fields, [], '提示词不在表单里，总是询问');
    assert.ok(created.length > 0);
  } finally {
    database.close();
  }
});

test('创建并生成提示词：先保存资产，后台用已保存内容、参考图和项目风格生成，写入提示词；仅创建不生成', async () => {
  const { database, projects, assets, text, notifications, created, open } = createFixture();
  try {
    projects.updateProject(created[0].id, { name: '项目甲', visualStyle: '写实摄影' });
    const image = { name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), width: 10, height: 10 };
    const form = open(ASSET_FORM_NAMES.create, { kind: 'character', projectId: created[0].id });
    await submit(form, { projectName: '项目甲', name: '林夏', appearance: '短发', files: JSON.stringify([image]) }, 'createAndPrompt');

    const [asset] = assets.listAssets('character');
    assert.equal(asset.promptStatus, 'running', '资产已入库，提示词在后台生成');
    await waitForPrompt(assets, asset.id);
    const done = assets.getAsset(asset.id);
    assert.deepEqual(
      [done.promptStatus, done.promptZh, done.promptEn, done.promptRevision, done.promptContentRevision, done.contentRevision],
      ['succeeded', '中文提示词', 'english prompt', 1, 1, 1]
    );
    const [request] = text.requests;
    assert.match(request.user, /角色名称：林夏/);
    assert.match(request.user, /角色外观：短发/);
    assert.match(request.user, /画面风格（沿用项目风格）：写实摄影/);
    assert.equal(request.images?.length, 1);
    assert.equal(request.tool.name, 'submit_asset_prompts');
    assert.ok(notifications.length >= 2, '开始和结束都通知界面刷新');

    await submit(form, { projectName: '项目甲', name: '周远', appearance: '长发' }, 'create');
    const other = assets.listAssets('character').find((item) => item.name === '周远');
    assert.equal(other?.promptStatus, 'none');
    assert.equal(text.requests.length, 1);
  } finally {
    database.close();
  }
});

test('创建并生成提示词：信息不足时不创建资产；仅创建不受限制', async () => {
  const { database, assets, created, open } = createFixture();
  try {
    const form = open(ASSET_FORM_NAMES.create, { kind: 'prop', projectId: created[0].id });
    await assert.rejects(
      submit(form, { projectName: '项目甲', name: '钥匙' }, 'createAndPrompt'),
      (error) => error instanceof ValidationError && /至少填写一项描述/.test(error.message)
    );
    assert.equal(assets.listAssets('prop').length, 0);
    await submit(form, { projectName: '项目甲', name: '钥匙' }, 'create');
    assert.equal(assets.listAssets('prop').length, 1);

    const audio = open(ASSET_FORM_NAMES.create, { kind: 'audio', projectId: created[0].id });
    await assert.rejects(submit(audio, { projectName: '项目甲', name: '雨声', audioKind: '音效' }, 'createAndPrompt'), ValidationError);
    await submit(audio, { projectName: '项目甲', name: '雨声', audioKind: '音效', description: '细雨敲窗' }, 'createAndPrompt');
    const rain = assets.listAssets('audio')[0];
    await waitForPrompt(assets, rain.id);
    assert.equal(assets.getAsset(rain.id).promptZh, '中文提示词');
    assert.equal(assets.getReferenceFiles(rain.id).length, 0, '音频文件可以暂时为空');
  } finally {
    database.close();
  }
});

test('提示词生成失败：资产照常创建，状态为失败并记录原因，重试可以成功', async () => {
  const { database, assets, prompts, text, created, open } = createFixture();
  try {
    text.unavailable = true;
    const form = open(ASSET_FORM_NAMES.create, { kind: 'prop', projectId: created[0].id });
    await submit(form, { projectName: '项目甲', name: '钥匙', appearance: '黄铜' }, 'createAndPrompt');
    const key = assets.listAssets('prop')[0];
    await waitForPrompt(assets, key.id);
    const failed = assets.getAsset(key.id);
    assert.deepEqual([failed.promptStatus, failed.promptError, failed.promptZh], ['failed', '未安装或未登录 Copilot。', '']);

    text.unavailable = false;
    await prompts.start(key.id).done;
    assert.deepEqual([assets.getAsset(key.id).promptStatus, assets.getAsset(key.id).promptError], ['succeeded', null]);
  } finally {
    database.close();
  }
});

test('提示词生成：取消记为已取消，不能重复启动；重启恢复把遗留任务置为失败', async () => {
  const { database, assets, prompts } = createFixture(['项目甲'], () => new Promise(() => undefined));
  try {
    const asset = assets.createAsset('prop', { projectName: '项目甲', name: '钥匙', appearance: '黄铜' });
    const { done } = prompts.start(asset.id);
    assert.throws(() => prompts.start(asset.id), /正在生成中/);
    assert.equal(prompts.recoverInterrupted(), 0, '本进程仍在跟踪的任务不会被恢复逻辑误伤');
    prompts.cancel(asset.id);
    await done;
    assert.deepEqual([assets.getAsset(asset.id).promptStatus, assets.getAsset(asset.id).promptError], ['canceled', null]);

    // 模拟上次退出时遗留的生成中状态。
    database.prepare("UPDATE assets SET prompt_status = 'running' WHERE id = ?").run(asset.id);
    assert.equal(prompts.recoverInterrupted(), 1);
    const recovered = assets.getAsset(asset.id);
    assert.deepEqual([recovered.promptStatus, recovered.promptError], ['failed', '扩展重启，已中断。']);
  } finally {
    database.close();
  }
});

test('编辑：保存并重新生成覆盖提示词；生成中保存保留库里的提示词；生成中不能再次生成', async () => {
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { database, assets, prompts, open } = createFixture(['项目甲'], () => gate);
  try {
    const asset = assets.createAsset('prop', { projectName: '项目甲', name: '钥匙', appearance: '黄铜' });
    assets.updatePrompts(asset.id, { promptZh: '旧中文', promptEn: 'old english' });
    const { done } = prompts.start(asset.id);

    const edit = open(ASSET_FORM_NAMES.edit, { assetId: asset.id });
    assert.ok(!edit.schema.fields.some((field) => field.key === 'promptZh' || field.key === 'promptEn'));
    await assert.rejects(submit(edit, { ...edit.initialValues }, 'saveAndPrompt'), (error) => error instanceof ValidationError && /正在生成中/.test(error.message));

    // 生成中保存其他字段：不动提示词，生成完成后是新生成的提示词。
    await submit(edit, { ...edit.initialValues, name: '钥匙二号' }, 'save');
    assert.equal(assets.getAsset(asset.id).name, '钥匙二号');
    release({ promptZh: '新中文', promptEn: 'new english' });
    await done;
    const finished = assets.getAsset(asset.id);
    assert.deepEqual([finished.promptZh, finished.promptEn, finished.promptStatus], ['新中文', 'new english', 'succeeded']);

    // 提示词已有内容时，“保存并重新生成”改写提示词；表单字段改动使表单修订号加 1，生成依据改动后的内容。
    const again = open(ASSET_FORM_NAMES.edit, { assetId: asset.id });
    await submit(again, { ...again.initialValues, appearance: '银色' }, 'saveAndPrompt');
    await waitForPrompt(assets, asset.id);
    const regenerated = assets.getAsset(asset.id);
    assert.deepEqual([regenerated.contentRevision, regenerated.promptContentRevision, regenerated.promptStatus], [2, 2, 'succeeded']);
  } finally {
    database.close();
  }
});

test('提示词表单：带出现有提示词与状态说明；保存即确认；生成中只读；重新生成走后台并要求覆盖确认', async () => {
  const { database, assets, open } = createFixture();
  try {
    const asset = assets.createAsset('prop', { projectName: '项目甲', name: '钥匙', appearance: '黄铜' });
    const empty = open(ASSET_FORM_NAMES.prompt, { assetId: asset.id });
    assert.equal(empty.schema.title, '提示词：钥匙');
    assert.deepEqual(empty.schema.fields.map((field) => [field.key, field.disabled]), [['promptZh', false], ['promptEn', false]]);
    assert.deepEqual((empty.schema.submitActions ?? []).map((action) => [action.key, action.label, action.primary]), [
      ['save', '保存', false],
      ['regenerate', '生成提示词', true]
    ]);

    await submit(empty, { promptZh: '黄铜钥匙', promptEn: 'a brass key' }, 'save');
    assets.updateAsset(asset.id, { name: '钥匙', appearance: '银质' });
    const outdated = open(ASSET_FORM_NAMES.prompt, { assetId: asset.id });
    assert.deepEqual([outdated.initialValues.promptZh, outdated.initialValues.promptEn], ['黄铜钥匙', 'a brass key']);
    assert.match(outdated.schema.fields[0].description, /可能需要更新/);
    const [save, regenerate] = outdated.schema.submitActions ?? [];
    assert.deepEqual([save.primary, regenerate.label, regenerate.confirmOverwrite?.fields], [true, '重新生成提示词', ['promptZh', 'promptEn']]);

    await submit(outdated, { promptZh: '黄铜钥匙', promptEn: 'a brass key' }, 'save');
    const confirmed = assets.getAsset(asset.id);
    assert.deepEqual([confirmed.promptRevision, confirmed.promptContentRevision, confirmed.contentRevision], [1, 2, 2]);
    assert.doesNotMatch(open(ASSET_FORM_NAMES.prompt, { assetId: asset.id }).schema.fields[0].description, /需要更新/);

    await submit(outdated, {}, 'regenerate');
    assert.equal(assets.getAsset(asset.id).promptStatus, 'running');
    const running = open(ASSET_FORM_NAMES.prompt, { assetId: asset.id });
    assert.deepEqual(running.schema.fields.map((field) => field.disabled), [true, true]);
    assert.match(running.schema.fields[0].description, /生成中/);
    await assert.rejects(submit(running, { promptZh: '新' }, 'save'), ValidationError);
    await waitForPrompt(assets, asset.id);
    assert.equal(assets.getAsset(asset.id).promptZh, '中文提示词');

    assert.throws(() => open(ASSET_FORM_NAMES.prompt, { assetId: 9999 }), NotFoundError);
    assert.throws(() => open(ASSET_FORM_NAMES.prompt, {}), ValidationError);
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
