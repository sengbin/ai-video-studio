// ------------------------------------------------------------------------
// 名称：asset-prompt-service.test.ts
// 说明：资产提示词后台生成服务的自动化测试：成功写回、取消时立即落库为已取消、取消后不被迟到的结果覆盖、重启恢复不改写已取消。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存数据库与真实的仓库、真实的提示词模板；文本模型用可手动结束的假实现，测试决定它何时返回。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { TextGenerationError } from '../../domain/errors';
import { TextGenerationPort, TextGenerationOptions } from '../../domain/ports/text-generation-port';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { FilePromptTemplates } from '../../infra/prompts/file-prompt-templates';
import { AssetPromptService } from './asset-prompt-service';
import { AssetService } from './asset-service';

const PROMPTS_DIRECTORY = join(resolve(__dirname, '..', '..', '..'), 'resources', 'prompts');
const GENERATED = { promptZh: '中文提示词', promptEn: 'english prompt' };

/** 一次挂起的 generate 调用：测试可让它成功、失败，signal 用于判断是否已被中止。 */
interface PendingCall {
  readonly signal: AbortSignal | undefined;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** 假文本端口：generate 挂起，直到测试结束它；abortRejects 为 true 时，收到中止信号会立即以“已取消”失败。 */
class FakeTextPort implements TextGenerationPort {
  readonly calls: PendingCall[] = [];

  constructor(private readonly abortRejects: boolean) {}

  async resolveModel() {
    return { id: 'fake/model', maxInputTokens: 100000 };
  }

  async countTokens(): Promise<number> {
    return 10;
  }

  generate(_request: unknown, options?: TextGenerationOptions): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.calls.push({ signal: options?.signal, resolve: resolvePromise, reject: rejectPromise });
      if (this.abortRejects) {
        options?.signal?.addEventListener('abort', () => rejectPromise(new TextGenerationError('canceled', '已取消。')));
      }
    });
  }
}

/** 创建内存数据库、资产服务、提示词服务与一个可生成提示词的资产。 */
function createFixture(abortRejects: boolean) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const repository = new SqliteAssetRepository(database);
  const assets = new AssetService(repository);
  const text = new FakeTextPort(abortRejects);
  let notifications = 0;
  const service = new AssetPromptService({
    text,
    prompts: new FilePromptTemplates(PROMPTS_DIRECTORY),
    assets: repository,
    notify: () => {
      notifications += 1;
    },
    now: () => new Date('2026-10-03T08:00:00.000Z')
  });
  const asset = assets.createAsset('character', { name: '林夏', appearance: '短发' });
  return { database, repository, assets, text, service, asset, notificationCount: () => notifications };
}

/** 等待假文本端口收到指定数量的调用（后台任务先要解析模型、估算 token）。 */
async function waitForCalls(text: FakeTextPort, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && text.calls.length < count; attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.equal(text.calls.length, count);
}

test('生成成功：提示词写回资产，状态为成功', async () => {
  const { database, service, text, assets, asset } = createFixture(true);
  try {
    const { done } = service.start(asset.id);
    assert.equal(assets.getAsset(asset.id).promptStatus, 'running');
    await waitForCalls(text, 1);
    text.calls[0].resolve(GENERATED);
    await done;
    const saved = assets.getAsset(asset.id);
    assert.deepEqual([saved.promptStatus, saved.promptZh, saved.promptEn, saved.promptError], ['succeeded', GENERATED.promptZh, GENERATED.promptEn, null]);
  } finally {
    database.close();
  }
});

test('取消：立即落库为已取消，不必等后台任务结束；任务结束后状态不变，重启恢复也不会改写', async () => {
  const { database, service, text, assets, asset, notificationCount } = createFixture(true);
  try {
    const { done } = service.start(asset.id);
    await waitForCalls(text, 1);
    const before = notificationCount();

    service.cancel(asset.id);
    // 后台任务还没结束（done 未完成）时，状态就已经是已取消，且已通知界面刷新。
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    assert.deepEqual([assets.getAsset(asset.id).promptStatus, assets.getAsset(asset.id).promptError], ['canceled', null]);
    assert.equal(finished, false);
    assert.ok(notificationCount() > before);
    assert.equal(text.calls[0].signal?.aborted, true);

    await done;
    assert.deepEqual([assets.getAsset(asset.id).promptStatus, assets.getAsset(asset.id).promptError], ['canceled', null]);
    assert.equal(service.recoverInterrupted(), 0);
    assert.equal(assets.getAsset(asset.id).promptStatus, 'canceled');
  } finally {
    database.close();
  }
});

test('取消后模型不响应中止、稍后才返回结果：结果被丢弃，状态保持已取消', async () => {
  const { database, service, text, assets, asset } = createFixture(false);
  try {
    const { done } = service.start(asset.id);
    await waitForCalls(text, 1);
    service.cancel(asset.id);
    text.calls[0].resolve(GENERATED);
    await done;
    const saved = assets.getAsset(asset.id);
    assert.deepEqual([saved.promptStatus, saved.promptZh, saved.promptEn], ['canceled', '', '']);
  } finally {
    database.close();
  }
});

test('取消后立即重新生成：迟到的旧任务不会改写新任务的状态与结果', async () => {
  const { database, service, text, assets, asset } = createFixture(false);
  try {
    const first = service.start(asset.id);
    await waitForCalls(text, 1);
    service.cancel(asset.id);

    const second = service.start(asset.id);
    await waitForCalls(text, 2);
    // 旧任务此时才以失败结束：不能把新任务的“生成中”改成失败。
    text.calls[0].reject(new Error('旧任务的迟到错误'));
    await first.done;
    assert.equal(assets.getAsset(asset.id).promptStatus, 'running');

    // 新任务仍可取消，说明它的登记没有被旧任务摘掉。
    service.cancel(asset.id);
    assert.equal(assets.getAsset(asset.id).promptStatus, 'canceled');
    text.calls[1].resolve(GENERATED);
    await second.done;
    assert.equal(assets.getAsset(asset.id).promptStatus, 'canceled');
  } finally {
    database.close();
  }
});

test('取消：没有进行中的任务时不做任何事；失败的任务不受影响', async () => {
  const { database, service, text, assets, asset, notificationCount } = createFixture(true);
  try {
    service.cancel(asset.id);
    assert.equal(assets.getAsset(asset.id).promptStatus, 'none');
    assert.equal(notificationCount(), 0);

    const { done } = service.start(asset.id);
    await waitForCalls(text, 1);
    text.calls[0].reject(new TextGenerationError('failed', '服务不可用。'));
    await done;
    assert.equal(assets.getAsset(asset.id).promptStatus, 'failed');
    service.cancel(asset.id);
    assert.equal(assets.getAsset(asset.id).promptStatus, 'failed');
  } finally {
    database.close();
  }
});
