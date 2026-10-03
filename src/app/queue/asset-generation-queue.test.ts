// ------------------------------------------------------------------------
// 名称：asset-generation-queue.test.ts
// 说明：资产生成队列的自动化测试：图片与音频的提交、轮询与结果保存，失败原因记录，提交重试，暂时性失败的容忍，取消与重试（含通知服务商取消失败时返回原因），平台成功但没有结果时记为失败，定时处理的停止（等待进行中的一轮），重启恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、假适配器、假下载器和可调的时钟；直接调用 pump() 驱动。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../domain/errors';
import { AssetRecord } from '../../domain/models/asset';
import { ImageGenerationRequest, RemoteJobRef } from '../../domain/ports/provider-adapters';
import { IMAGE_URL, PNG_BYTES, createAssetGenerationFixture, createAssetWithPrompts } from '../services/testing/asset-generation-fixture';

type Fixture = Awaited<ReturnType<typeof createAssetGenerationFixture>>;

/** 创建带提示词的图片资产。 */
function createCharacter(fixture: Fixture): AssetRecord {
  return createAssetWithPrompts(fixture.assets, 'character', {
    name: '林夏',
    appearance: '短发',
    referenceAspectRatio: '16:9',
    promptZh: '短发的年轻女子，半身像',
    promptEn: 'a young woman with short hair, half-length portrait'
  });
}

/** 创建带提示词的音色参考音频资产。 */
function createVoice(fixture: Fixture): AssetRecord {
  return createAssetWithPrompts(fixture.assets, 'audio', {
    name: '林夏的声音',
    audioKind: '音色参考',
    language: '中文',
    promptZh: '清亮的女声，语速适中',
    promptEn: 'a clear female voice at a moderate pace'
  });
}

/** 取资产的第一个可用模型并提交一个版本。 */
async function submitVersion(fixture: Fixture, asset: AssetRecord, extra: Record<string, unknown> = {}): Promise<number> {
  const catalog = await fixture.generation.getCatalog(asset.id);
  const { versionId } = await fixture.generation.submit({ assetId: asset.id, modelId: catalog.models[0].id, promptLanguage: 'zh', ...extra });
  return versionId;
}

test('图片：提交后转为生成中，轮询到成功后下载全部结果并保存为版本文件', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const second = 'https://fake.example.com/image-2.png';
    fixture.downloads.set(second, PNG_BYTES);
    fixture.image.queryStates.push({ status: 'succeeded', result: { imageUrls: [IMAGE_URL, second] }, errorCategory: null, errorCode: null, errorMessage: null });
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset, { count: 2, aspectRatio: '16:9', resolution: '2K' });

    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'running');
    const request: ImageGenerationRequest = fixture.image.submitted[0];
    assert.deepEqual(
      [request.modelCode, request.prompt, request.count, request.aspectRatio, request.resolution, request.referenceImages.length],
      ['fake-image', '短发的年轻女子，半身像', 2, '16:9', '2K', 0]
    );

    await fixture.queue.pump();
    const version = fixture.versions.findVersion(versionId);
    assert.equal(version?.status, 'succeeded');
    const files = fixture.versions.listFiles(versionId);
    assert.deepEqual(files.map((file) => [file.role, file.sortOrder, file.mime, file.fileName]), [
      ['result', 0, 'image/png', 'v1-1.png'],
      ['result', 1, 'image/png', 'v1-2.png']
    ]);
    assert.equal(fixture.changes.at(-1)?.versionId, versionId);
  } finally {
    fixture.database.close();
  }
});

test('图片：提示词语言选英文时发送英文提示词；勾选参考图时带上资产现有的参考图', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createAssetWithPrompts(fixture.assets, 'character', {
      name: '林夏',
      appearance: '短发',
      promptZh: '中文',
      promptEn: 'english',
      files: JSON.stringify([{ name: 'a.png', mimeType: 'image/png', size: PNG_BYTES.length, data: PNG_BYTES.toString('base64'), width: 1, height: 1 }])
    });
    await submitVersion(fixture, asset, { promptLanguage: 'en', useReferenceImages: true });
    await fixture.queue.pump();
    const request = fixture.image.submitted[0];
    assert.deepEqual([request.prompt, request.referenceImages.length, request.referenceImages[0].mimeType], ['english', 1, 'image/png']);
  } finally {
    fixture.database.close();
  }
});

test('音频：按资产的音频类型提交，结果保存为带时长的音频文件', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createVoice(fixture);
    const versionId = await submitVersion(fixture, asset, { language: 'zh', voice: '小红' });
    await fixture.queue.pump();
    const request = fixture.audio.submitted[0];
    assert.deepEqual([request.audioKind, request.prompt, request.language, request.voice], ['voice', '清亮的女声，语速适中', 'zh', '小红']);

    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'succeeded');
    const [file] = fixture.versions.listFiles(versionId);
    assert.deepEqual([file.mime, file.durationSeconds, file.fileName], ['audio/wav', 3.5, 'v1.wav']);
  } finally {
    fixture.database.close();
  }
});

test('平台返回失败：记录分类、错误码与原文；返回的文件不是有效图片时直接失败', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    fixture.image.queryStates.push({
      status: 'failed',
      result: null,
      errorCategory: 'content_rejected',
      errorCode: 'DataInspectionFailed',
      errorMessage: 'Input data may contain inappropriate content.'
    });
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    await fixture.queue.pump();
    const failed = fixture.versions.findVersion(versionId);
    assert.deepEqual([failed?.status, failed?.errorCategory, failed?.errorCode, failed?.errorMessage], [
      'failed',
      'content_rejected',
      'DataInspectionFailed',
      'Input data may contain inappropriate content.'
    ]);

    fixture.downloads.set(IMAGE_URL, Buffer.from('not an image'));
    await fixture.generation.retry(versionId);
    await fixture.queue.pump();
    await fixture.queue.pump();
    const invalid = fixture.versions.findVersion(versionId);
    assert.equal(invalid?.status, 'failed');
    assert.match(invalid?.errorMessage ?? '', /不是有效的 PNG、JPEG 或 WebP 图片/);
    assert.equal(invalid?.attempt, 2, '重试在原版本上进行，尝试次数加 1');
  } finally {
    fixture.database.close();
  }
});

test('提交遇到限流：保持排队，等待间隔后重试；参数错误直接失败', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const original = fixture.image.submit.bind(fixture.image);
    let failures = 1;
    fixture.image.submit = async (request) => {
      if (failures-- > 0) throw new ProviderError('rate_limited', '请求过于频繁');
      return original(request);
    };
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'queued');
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'queued', '间隔未到不重试');
    fixture.clock.time += 1500;
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'running');

    fixture.image.submit = async () => {
      throw new ProviderError('invalid_request', '参数不对');
    };
    await fixture.queue.pump();
    const another = createVoiceAsImage(fixture);
    const secondId = await submitVersion(fixture, another);
    await fixture.queue.pump();
    const rejected = fixture.versions.findVersion(secondId);
    assert.deepEqual([rejected?.status, rejected?.errorCategory], ['failed', 'invalid_request']);
  } finally {
    fixture.database.close();
  }
});

/** 另一个图片资产，用于需要第二个版本的场景。 */
function createVoiceAsImage(fixture: Fixture): AssetRecord {
  return createAssetWithPrompts(fixture.assets, 'prop', { name: '钥匙', appearance: '黄铜', promptZh: '一把黄铜钥匙', promptEn: 'a brass key' });
}

test('下载失败按暂时性失败处理：容忍次数内保持生成中，超过后记为失败', async () => {
  const fixture = await createAssetGenerationFixture({ queue: { maxTransientFailures: 1 } });
  try {
    fixture.downloads.delete(IMAGE_URL);
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'running');
    await fixture.queue.pump();
    const failed = fixture.versions.findVersion(versionId);
    assert.deepEqual([failed?.status, failed?.errorCategory], ['failed', 'network']);
    assert.match(failed?.errorMessage ?? '', /下载失败/);
  } finally {
    fixture.database.close();
  }
});

test('取消：生成中的版本记为已取消，之后的轮询不会覆盖；已取消的版本可以重试', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    const result = await fixture.generation.cancel(versionId);
    assert.deepEqual(result, { remoteCanceled: false });
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'canceled');
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'canceled');
    await assert.rejects(fixture.generation.cancel(versionId), /已经结束/);

    await fixture.generation.retry(versionId);
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'queued');
    await fixture.queue.pump();
    await fixture.queue.pump();
    assert.deepEqual([fixture.versions.findVersion(versionId)?.status, fixture.versions.findVersion(versionId)?.attempt], ['succeeded', 2]);
  } finally {
    fixture.database.close();
  }
});

test('取消：通知服务商取消失败时本地取消仍然成功，失败原因随结果返回', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const provider = fixture.image as typeof fixture.image & { cancel?: (ref: RemoteJobRef) => Promise<void> };
    provider.cancel = async () => {
      throw new Error('平台返回 500');
    };
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    assert.deepEqual(await fixture.queue.cancel(versionId), { remoteCanceled: false, remoteCancelError: '平台返回 500' });
    assert.equal(fixture.versions.findVersion(versionId)?.status, 'canceled');
  } finally {
    fixture.database.close();
  }
});

test('平台报告成功但没有结果：记为失败并说明原因，不保持生成中', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    await fixture.queue.pump();
    fixture.image.queryStates.push({ status: 'succeeded', result: null, errorCategory: null, errorCode: null, errorMessage: null });
    await fixture.queue.pump();
    const failed = fixture.versions.findVersion(versionId);
    assert.deepEqual([failed?.status, failed?.errorCategory], ['failed', 'server']);
    assert.match(failed?.errorMessage ?? '', /没有返回结果文件/);
    assert.equal(fixture.changes.at(-1)?.versionId, versionId);
  } finally {
    fixture.database.close();
  }
});

test('定时处理：start 立即处理一轮；停止函数等进行中的一轮处理完，之后定时器与手动 pump 都不再处理', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = fixture.image.submit.bind(fixture.image);
    fixture.image.submit = async (request) => {
      await gate;
      return submit(request);
    };
    const firstId = await submitVersion(fixture, createCharacter(fixture));
    const stop = fixture.queue.start(20);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.versions.findVersion(firstId)?.status, 'queued', '这一轮停在提交中');

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped, false, '进行中的一轮没结束时，停止函数一直等待');
    release();
    await stopping;
    assert.equal(fixture.versions.findVersion(firstId)?.status, 'running', '进行中的一轮处理完才返回');

    const secondId = await submitVersion(fixture, createVoiceAsImage(fixture));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fixture.queue.pump();
    assert.equal(fixture.versions.findVersion(secondId)?.status, 'queued', '停止后不再开始新的一轮');
    await stop();
  } finally {
    fixture.database.close();
  }
});

test('并发上限：超过上限的版本继续排队；启动恢复把没有远端标识的生成中版本记为失败', async () => {
  const fixture = await createAssetGenerationFixture({ queue: { maxConcurrent: 1 } });
  try {
    const first = createCharacter(fixture);
    const second = createVoiceAsImage(fixture);
    const firstId = await submitVersion(fixture, first);
    const secondId = await submitVersion(fixture, second);
    await fixture.queue.pump();
    assert.deepEqual([fixture.versions.findVersion(firstId)?.status, fixture.versions.findVersion(secondId)?.status], ['running', 'queued']);
    await fixture.queue.pump();
    assert.deepEqual([fixture.versions.findVersion(firstId)?.status, fixture.versions.findVersion(secondId)?.status], ['succeeded', 'running'], '第一个完成后同一轮就提交排队的版本');

    fixture.database.prepare("UPDATE asset_versions SET remote_job_id = NULL WHERE id = ?").run(secondId);
    assert.equal(fixture.queue.recover(), 1);
    const interrupted = fixture.versions.findVersion(secondId);
    assert.deepEqual([interrupted?.status, interrupted?.errorMessage], ['failed', '扩展重启，已中断。']);
  } finally {
    fixture.database.close();
  }
});

test('模型已停用或资产已删除时提交失败并记录原因', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    const asset = createCharacter(fixture);
    const versionId = await submitVersion(fixture, asset);
    const model = (await fixture.providerService.listUsableModels('image'))[0].model;
    await fixture.providerService.setModelEnabled({ modelId: model.id, isEnabled: false });
    await fixture.queue.pump();
    const failed = fixture.versions.findVersion(versionId);
    assert.deepEqual([failed?.status, failed?.errorCategory], ['failed', 'invalid_request']);
    assert.match(failed?.errorMessage ?? '', /已被停用/);
  } finally {
    fixture.database.close();
  }
});
