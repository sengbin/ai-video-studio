// ------------------------------------------------------------------------
// 名称：asset-generation-service.test.ts
// 说明：资产生成服务的自动化测试：生成对话框的目录与默认值、提交校验、修订号推算“需更新”“有改动未生成”、缩略图补存、采用与删除版本。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、假适配器和假下载器，队列由测试显式驱动。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { AssetRecord } from '../../domain/models/asset';
import { IMAGE_URL, PNG_BYTES, WAV_BYTES, createAssetGenerationFixture, createAssetWithPrompts } from './testing/asset-generation-fixture';

type Fixture = Awaited<ReturnType<typeof createAssetGenerationFixture>>;

/** 创建带中英文提示词的角色资产。 */
function createCharacter(fixture: Fixture, overrides: Record<string, unknown> = {}): AssetRecord {
  return createAssetWithPrompts(fixture.assets, 'character', {
    projectName: '项目甲',
    name: '林夏',
    appearance: '短发',
    referenceAspectRatio: '16:9',
    promptZh: '短发的年轻女子',
    promptEn: 'a young woman with short hair',
    ...overrides
  });
}

/** 按资产现有内容加改动保存（保存会整体替换内容，所以要带上原有字段；提示词不在表单里）。 */
function edit(fixture: Fixture, asset: AssetRecord, patch: Record<string, unknown>): AssetRecord {
  return fixture.assets.updateAsset(asset.id, {
    name: asset.name,
    appearance: asset.attributes.appearance,
    referenceAspectRatio: asset.referenceAspectRatio ?? '',
    ...patch
  });
}

/** 手动保存提示词。 */
function editPrompts(fixture: Fixture, asset: AssetRecord, patch: Record<string, unknown>): AssetRecord {
  return fixture.assets.updatePrompts(asset.id, { promptZh: asset.promptZh, promptEn: asset.promptEn, ...patch });
}

async function modelIdOf(fixture: Fixture, asset: AssetRecord): Promise<number> {
  return (await fixture.generation.getCatalog(asset.id)).models[0].id;
}

/** 提交并让队列跑到成功。 */
async function generate(fixture: Fixture, asset: AssetRecord, extra: Record<string, unknown> = {}): Promise<number> {
  const { versionId } = await fixture.generation.submit({ assetId: asset.id, modelId: await modelIdOf(fixture, asset), promptLanguage: 'zh', ...extra });
  await fixture.queue.pump();
  await fixture.queue.pump();
  return versionId;
}

test('生成目录：没有提示词、没有可用模型时不能生成并说明原因；条件满足后给出模型与默认值', async () => {
  const noKey = await createAssetGenerationFixture({ withApiKey: false });
  try {
    const asset = createCharacter(noKey, { promptZh: '', promptEn: '' });
    assert.deepEqual((await noKey.generation.getCatalog(asset.id)).availability, { available: false, reason: '请先生成或填写提示词。' });
    const withPrompt = createCharacter(noKey, { name: '周远' });
    const catalog = await noKey.generation.getCatalog(withPrompt.id);
    assert.equal(catalog.availability.available, false);
    assert.match(catalog.availability.reason ?? '', /启用图像模型并配置访问密钥/);
    assert.deepEqual(catalog.models, []);
  } finally {
    noKey.database.close();
  }

  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const catalog = await fixture.generation.getCatalog(asset.id);
    assert.deepEqual([catalog.availability.available, catalog.modelKind, catalog.models.map((model) => model.label), catalog.referenceCount], [true, 'image', ['假服务商 · 假图像模型'], 0]);
    assert.deepEqual(catalog.defaults, {
      modelId: catalog.models[0].id,
      promptLanguage: 'zh',
      count: 1,
      aspectRatio: '16:9',
      resolution: '',
      language: '',
      voice: '',
      useReferenceImages: false
    });

    const voice = createAssetWithPrompts(fixture.assets, 'audio', { projectName: '项目甲', name: '声音', audioKind: '音色参考', language: '英文', promptZh: '声音' });
    const audioCatalog = await fixture.generation.getCatalog(voice.id);
    assert.deepEqual([audioCatalog.modelKind, audioCatalog.defaults.language, audioCatalog.models.length], ['audio', 'en', 1]);
    const music = createAssetWithPrompts(fixture.assets, 'audio', { projectName: '项目甲', name: '配乐', audioKind: '背景音乐', promptZh: '紧张' });
    const musicCatalog = await fixture.generation.getCatalog(music.id);
    assert.equal(musicCatalog.models.length, 0, '假音频模型不支持配乐');
    assert.equal(musicCatalog.availability.available, false);
    await assert.rejects(fixture.generation.getCatalog(9999), NotFoundError);
  } finally {
    fixture.database.close();
  }
});

test('提交校验：模型、语言、数量、画幅、分辨率、提示词长度与参考图，以及同一资产只能有一个进行中的版本', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture, { promptEn: '' });
    const modelId = await modelIdOf(fixture, asset);
    const fieldErrors = async (input: Record<string, unknown>): Promise<Record<string, string>> => {
      try {
        await fixture.generation.submit({ assetId: asset.id, modelId, promptLanguage: 'zh', ...input });
      } catch (error) {
        return error instanceof ValidationError ? error.fieldErrors : {};
      }
      return {};
    };
    assert.ok((await fieldErrors({ modelId: 9999 })).modelId);
    assert.ok((await fieldErrors({ promptLanguage: 'fr' })).promptLanguage);
    assert.match((await fieldErrors({ promptLanguage: 'en' })).promptLanguage, /英文提示词为空/);
    assert.ok((await fieldErrors({ count: 0 })).count);
    assert.ok((await fieldErrors({ count: 5 })).count);
    assert.ok((await fieldErrors({ count: 1.5 })).count);
    assert.ok((await fieldErrors({ aspectRatio: '4:3' })).aspectRatio);
    assert.ok((await fieldErrors({ resolution: '8K' })).resolution);
    assert.ok((await fieldErrors({ useReferenceImages: true })).useReferenceImages, '资产还没有参考图');

    const long = createCharacter(fixture, { name: '长提示词', promptZh: '长'.repeat(501) });
    await assert.rejects(
      fixture.generation.submit({ assetId: long.id, modelId, promptLanguage: 'zh' }),
      (error) => error instanceof ValidationError && /超过所选模型的上限 500 字/.test(error.fieldErrors.promptLanguage)
    );

    const { version } = await fixture.generation.submit({ assetId: asset.id, modelId, promptLanguage: 'zh', count: 2 });
    assert.equal(version, 1);
    await assert.rejects(
      fixture.generation.submit({ assetId: asset.id, modelId, promptLanguage: 'zh' }),
      (error) => error instanceof ValidationError && /正在生成/.test(error.message)
    );
    assert.ok(fixture.notifications.length > 0);
  } finally {
    fixture.database.close();
  }
});

test('版本号只在提交时加 1；修改提示词或表单后显示“有改动未生成”，表单改动还会让提示词“需更新”，不产生空版本', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    let list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.versions.length, list.hasUngeneratedChanges, list.isPromptOutdated, list.availability.available], [0, false, false, true]);

    const firstId = await generate(fixture, asset);
    list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.versions.map((v) => [v.version, v.status, v.isOutdated]), list.hasUngeneratedChanges], [[[1, 'succeeded', false]], false]);

    // 只改提示词：图片有改动未生成，提示词不算过期。
    const afterPrompt = editPrompts(fixture, asset, { promptZh: '改过的提示词' });
    assert.deepEqual([afterPrompt.contentRevision, afterPrompt.promptRevision, afterPrompt.promptContentRevision], [1, 2, 1]);
    list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.versions.length, list.hasUngeneratedChanges, list.isPromptOutdated, list.versions[0].isOutdated], [1, true, false, true]);

    // 改表单字段：内容修订号加 1，提示词需更新，图片仍是有改动未生成。
    const afterForm = edit(fixture, afterPrompt, { appearance: '长发' });
    assert.deepEqual([afterForm.contentRevision, afterForm.promptRevision, afterForm.promptContentRevision], [2, 2, 1]);
    list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.hasUngeneratedChanges, list.isPromptOutdated], [true, true]);

    // 重新生成后版本号加 1，新版本依据最新的修订号。
    const secondId = await generate(fixture, afterForm);
    assert.notEqual(secondId, firstId);
    list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.versions.map((v) => v.version), list.versions[0].isOutdated, list.versions[1].isOutdated, list.hasUngeneratedChanges], [[2, 1], false, true, false]);

    // 改了表单再手动保存提示词：视为已确认（文本没变也一样）；只改名称不算改动。
    const formChanged = edit(fixture, afterForm, { appearance: '卷发' });
    assert.deepEqual([formChanged.contentRevision, formChanged.promptRevision, formChanged.promptContentRevision], [3, 2, 1]);
    const both = editPrompts(fixture, formChanged, { promptZh: '卷发的女子' });
    assert.deepEqual([both.contentRevision, both.promptRevision, both.promptContentRevision], [3, 3, 3]);
    const renamed = edit(fixture, both, { name: '林夏二号', appearance: '卷发' });
    assert.deepEqual([renamed.contentRevision, renamed.promptRevision], [3, 3]);
    const confirmed = editPrompts(fixture, edit(fixture, renamed, { name: '林夏二号', appearance: '短发' }), {});
    assert.deepEqual([confirmed.contentRevision, confirmed.promptRevision, confirmed.promptContentRevision], [4, 3, 4]);
  } finally {
    fixture.database.close();
  }
});

test('缩略图补存与采用：缩略图未就绪不能采用；可勾选部分图片，整体替换参考文件并记录采用的版本', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const second = 'https://fake.example.com/image-2.png';
    fixture.downloads.set(second, PNG_BYTES);
    fixture.image.queryStates.push({ status: 'succeeded', result: { imageUrls: [IMAGE_URL, second] }, errorCategory: null, errorCode: null, errorMessage: null });
    const asset = createCharacter(fixture, {
      files: JSON.stringify([{ name: 'manual.png', mimeType: 'image/png', size: PNG_BYTES.length, data: PNG_BYTES.toString('base64'), width: 1, height: 1 }])
    });
    const versionId = await generate(fixture, asset, { count: 2 });
    let detail = fixture.generation.getVersion(versionId);
    assert.deepEqual([detail.files.length, detail.missingThumbnails, detail.usedByEpisodes], [2, [0, 1], 0]);
    assert.throws(() => fixture.generation.adopt({ versionId }), /缩略图还没有准备好/);

    const thumb = { mimeType: 'image/png', data: PNG_BYTES.toString('base64') };
    fixture.generation.saveThumbnails({ versionId, items: [{ sortOrder: 0, width: 800, height: 600, thumbnail: thumb }, { sortOrder: 1, width: 800, height: 600, thumbnail: thumb }] });
    detail = fixture.generation.getVersion(versionId);
    assert.deepEqual([detail.missingThumbnails, detail.files.map((file) => [file.width, file.height, file.thumbnail?.mime])], [[], [[800, 600, 'image/png'], [800, 600, 'image/png']]]);
    assert.throws(() => fixture.generation.saveThumbnails({ versionId, items: [{ sortOrder: 0, width: 1, height: 1, thumbnail: { mimeType: 'image/png', data: Buffer.from('abc').toString('base64') } }] }), /不是有效的图片/);
    assert.throws(() => fixture.generation.saveThumbnails({ versionId, items: [] }), ValidationError);

    assert.throws(() => fixture.generation.adopt({ versionId, fileIds: [] }), /请选择要采用的文件/);
    assert.throws(() => fixture.generation.adopt({ versionId, fileIds: [999999] }), /请选择要采用的文件/);
    fixture.generation.adopt({ versionId, fileIds: [detail.files[1].id] });

    const adopted = fixture.assets.getAsset(asset.id);
    assert.equal(adopted.adoptedVersionId, versionId);
    const references = fixture.assets.getReferenceFiles(asset.id);
    assert.deepEqual(references.map((file) => [file.fileName, file.sortOrder]), [['v1-2.png', 0]], '手动上传的参考图被整体替换');
    assert.equal(fixture.assetRepository.listThumbnailFiles(asset.id).length, 1);
    detail = fixture.generation.getVersion(versionId);
    assert.deepEqual(detail.files.map((file) => file.isAdopted), [false, true]);
    const list = await fixture.generation.listVersions(asset.id);
    assert.deepEqual([list.adoptedVersionId, list.versions[0].isAdopted, list.hasManualFiles], [versionId, true, false]);
    assert.equal(fixture.assets.listAssets('character')[0].generation.adoptedVersion, 1);

    // 保存表单时文件不变，仍然对应采用的版本；换了文件则不再对应任何版本。
    assert.equal(fixture.assets.updateAsset(asset.id, { name: '林夏', appearance: '短发', promptZh: '短发的年轻女子', promptEn: 'a young woman with short hair', referenceAspectRatio: '16:9', files: JSON.stringify(references.map((file) => ({ name: file.fileName, mimeType: file.mime, size: file.content.length, data: file.content.toString('base64') }))) }).adoptedVersionId, versionId);
    const manual = fixture.assets.updateAsset(asset.id, { name: '林夏', appearance: '短发', promptZh: '短发的年轻女子', promptEn: 'a young woman with short hair', referenceAspectRatio: '16:9', files: JSON.stringify([{ name: 'other.png', mimeType: 'image/png', size: PNG_BYTES.length, data: PNG_BYTES.toString('base64'), width: 1, height: 1 }]) });
    assert.equal(manual.adoptedVersionId, null);
    assert.equal((await fixture.generation.listVersions(asset.id)).hasManualFiles, true);
  } finally {
    fixture.database.close();
  }
});

test('采用的版本不能删除，进行中的版本要先取消；其他版本可以删除并连同文件清除', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const first = await generate(fixture, asset);
    const thumb = { mimeType: 'image/png', data: PNG_BYTES.toString('base64') };
    fixture.generation.saveThumbnails({ versionId: first, items: [{ sortOrder: 0, width: 10, height: 10, thumbnail: thumb }] });
    fixture.generation.adopt({ versionId: first });
    const second = await generate(fixture, asset);

    assert.throws(() => fixture.generation.deleteVersion(first), /正在被采用/);
    fixture.generation.deleteVersion(second);
    assert.equal(fixture.versions.findVersion(second), undefined);
    assert.equal(fixture.versions.listFiles(second).length, 0);

    const running = (await fixture.generation.submit({ assetId: asset.id, modelId: await modelIdOf(fixture, asset), promptLanguage: 'zh' })).versionId;
    assert.throws(() => fixture.generation.deleteVersion(running), /还在生成中/);
    await assert.rejects(fixture.generation.retry(running), /只有失败或已取消/);
    assert.throws(() => fixture.generation.getVersion(9999), NotFoundError);
    assert.throws(() => fixture.generation.getFileData(9999), NotFoundError);
    const detail = fixture.generation.getVersion(first);
    const data = fixture.generation.getFileData(detail.files[0].id);
    assert.deepEqual([data.mime, Buffer.from(data.data, 'base64').equals(PNG_BYTES)], ['image/png', true]);
  } finally {
    fixture.database.close();
  }
});

test('音频：只能采用 1 个文件且不超过 60 秒，采用后音频资产有了文件；之后才能绑定为音色', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const voice = createAssetWithPrompts(fixture.assets, 'audio', { projectName: '项目甲', name: '声音', audioKind: '音色参考', promptZh: '清亮的女声' });
    assert.equal(fixture.assetRepository.countReferenceFiles(voice.id), 0);
    const versionId = await generate(fixture, voice);
    const detail = fixture.generation.getVersion(versionId);
    assert.deepEqual([detail.files.length, detail.missingThumbnails, detail.files[0].durationSeconds], [1, [], 3.5]);
    assert.throws(() => fixture.generation.adopt({ versionId, fileIds: [detail.files[0].id, detail.files[0].id] }), /只能采用 1 个文件/);

    fixture.database.prepare("UPDATE asset_version_files SET duration_seconds = 61 WHERE version_id = ?").run(versionId);
    assert.throws(() => fixture.generation.adopt({ versionId }), /超过 60 秒/);
    fixture.database.prepare("UPDATE asset_version_files SET duration_seconds = 12 WHERE version_id = ?").run(versionId);
    fixture.generation.adopt({ versionId });
    const [file] = fixture.assets.getReferenceFiles(voice.id);
    assert.deepEqual([file.mime, file.durationSeconds, file.content.equals(WAV_BYTES)], ['audio/wav', 12, true]);
    assert.equal(fixture.assets.getAsset(voice.id).adoptedVersionId, versionId);
  } finally {
    fixture.database.close();
  }
});

test('只有成功的版本可以采用', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const { versionId } = await fixture.generation.submit({ assetId: asset.id, modelId: await modelIdOf(fixture, asset), promptLanguage: 'zh' });
    assert.throws(() => fixture.generation.adopt({ versionId }), /只有生成成功的版本可以采用/);
    assert.throws(() => fixture.generation.adopt({}), ValidationError);
  } finally {
    fixture.database.close();
  }
});
