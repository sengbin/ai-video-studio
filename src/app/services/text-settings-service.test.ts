// ------------------------------------------------------------------------
// 名称：text-settings-service.test.ts
// 说明：文本生成设置服务的自动化测试：设置视图、修改校验，以及 Copilot 与千问文本模型二选一的规则。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存中的设置存储、模型清单与文本模型管理，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { ModelKind } from '../../domain/models/model-capability';
import { ModelRecord, ProviderView } from '../../domain/models/model-provider';
import { TextGenerationSettingsStore, TextModelCatalog, TextModelFamilies } from '../../domain/ports/text-generation-settings-store';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  TextGenerationSettings,
  TextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';
import {
  COPILOT_OFF_NEEDS_MODEL_MESSAGE,
  COPILOT_ON_CONFLICT_MESSAGE,
  LAST_TEXT_MODEL_MESSAGE,
  MODEL_MISSING_HINT,
  NO_TEXT_ENGINE_NOTE,
  TextModelAdmin,
  TextSettingsService
} from './text-settings-service';

/** 内存中的设置存储。 */
class MemoryStore implements TextGenerationSettingsStore {
  settings: TextGenerationSettings = { copilotEnabled: true, modelFamily: '', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } };
  readonly writes: TextGenerationSettingsPatch[] = [];
  failWrites = false;

  read(): TextGenerationSettings {
    return this.settings;
  }

  async write(patch: TextGenerationSettingsPatch): Promise<void> {
    if (this.failWrites) {
      throw new Error('写入失败');
    }
    this.writes.push(patch);
    this.settings = {
      copilotEnabled: patch.copilotEnabled ?? this.settings.copilotEnabled,
      modelFamily: patch.modelFamily ?? this.settings.modelFamily,
      novelSplit: {
        mode: patch.splitMode ?? this.settings.novelSplit.mode,
        maxSegmentChars: patch.maxSegmentChars ?? this.settings.novelSplit.maxSegmentChars
      }
    };
  }
}

/** 内存中的模型管理：两个文本模型和一个视频模型。 */
class MemoryModels implements TextModelAdmin {
  readonly models: ModelRecord[] = [
    createModel(1, 'text', '千问文本一'),
    createModel(2, 'text', '千问文本二'),
    createModel(3, 'video', '视频')
  ];

  findModel(modelId: number): ModelRecord | undefined {
    return this.models.find((model) => model.id === modelId);
  }

  listTextModels(): ModelRecord[] {
    return this.models.filter((model) => model.kind === 'text');
  }

  disableTextModels(): void {
    this.replaceEach((model) => (model.kind === 'text' ? { ...model, isEnabled: false } : model));
  }

  async setModelEnabled(rawInput: unknown): Promise<ProviderView> {
    const { modelId, isEnabled } = rawInput as { modelId: number; isEnabled: boolean };
    this.replaceEach((model) => (model.id === modelId ? { ...model, isEnabled } : model));
    return { id: 1 } as ProviderView;
  }

  enable(...ids: number[]): void {
    this.replaceEach((model) => (ids.includes(model.id) ? { ...model, isEnabled: true } : model));
  }

  enabledIds(): number[] {
    return this.models.filter((model) => model.isEnabled).map((model) => model.id);
  }

  private replaceEach(change: (model: ModelRecord) => ModelRecord): void {
    this.models.forEach((model, index) => {
      this.models[index] = change(model);
    });
  }
}

function createModel(id: number, kind: ModelKind, displayName: string): ModelRecord {
  return {
    id,
    providerId: 1,
    code: `m${id}`,
    displayName,
    kind,
    isEnabled: false,
    capability: { contextTokens: 1, maxOutputTokens: 1, imageInput: false },
    createdAt: '2026-10-03T00:00:00.000Z'
  };
}

function createService(models: TextModelFamilies = { families: [] }) {
  const store = new MemoryStore();
  const admin = new MemoryModels();
  const catalog: TextModelCatalog = { listFamilies: async () => models };
  return { store, admin, service: new TextSettingsService(store, catalog, admin) };
}

test('设置视图：默认使用 Copilot，返回可选模型与字数范围', async () => {
  const { service } = createService({ families: ['claude-sonnet', 'gpt-4o'] });
  assert.deepEqual(await service.getView(), {
    copilotEnabled: true,
    modelFamily: '',
    splitMode: 'chapter',
    maxSegmentChars: 20000,
    segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
    families: ['claude-sonnet', 'gpt-4o'],
    modelNote: null,
    enabledTextModels: [],
    engineNote: null
  });
});

test('设置视图：没有可用模型时说明原因；已保存的模型不可用时提示将使用自动', async () => {
  const none = createService({ families: [], unavailableReason: '未检测到可用的 Copilot 模型。' });
  none.store.settings = { ...none.store.settings, modelFamily: 'gpt-4o' };
  assert.equal((await none.service.getView()).modelNote, '未检测到可用的 Copilot 模型。');

  const missing = createService({ families: ['claude-sonnet'] });
  missing.store.settings = { ...missing.store.settings, modelFamily: 'gpt-4o' };
  assert.equal((await missing.service.getView()).modelNote, MODEL_MISSING_HINT);

  const ok = createService({ families: ['gpt-4o'] });
  ok.store.settings = { ...ok.store.settings, modelFamily: 'gpt-4o' };
  assert.equal((await ok.service.getView()).modelNote, null);
});

test('设置视图：关闭 Copilot 后不再查询 Copilot 模型，显示已启用的千问文本模型；没有启用时给出警告', async () => {
  const { store, admin, service } = createService({ families: ['gpt-4o'], unavailableReason: '不应出现' });
  store.settings = { ...store.settings, copilotEnabled: false };

  const warned = await service.getView();
  assert.deepEqual([warned.families, warned.modelNote, warned.enabledTextModels, warned.engineNote], [[], null, [], NO_TEXT_ENGINE_NOTE]);

  admin.enable(2);
  const active = await service.getView();
  assert.deepEqual([active.enabledTextModels, active.engineNote], [['千问文本二'], null]);
});

test('保存设置：只写出现的项，模型名去除空白，下次读取即为新值', async () => {
  const { store, service } = createService({ families: ['gpt-4o'] });
  await service.update({ modelFamily: ' gpt-4o ' });
  await service.update({ splitMode: 'length', maxSegmentChars: 30000 });
  assert.deepEqual(store.writes, [{ modelFamily: 'gpt-4o' }, { splitMode: 'length', maxSegmentChars: 30000 }]);
  const view = await service.getView();
  assert.deepEqual([view.modelFamily, view.splitMode, view.maxSegmentChars], ['gpt-4o', 'length', 30000]);
});

test('保存设置：不合法的值被拒绝且不写入', async () => {
  const { store, service } = createService();
  const rejected = async (patch: unknown) =>
    assert.rejects(() => service.update(patch), (error) => error instanceof ValidationError);

  await rejected({ splitMode: 'paragraph' });
  await rejected({ maxSegmentChars: SEGMENT_CHARS_MIN - 1 });
  await rejected({ maxSegmentChars: SEGMENT_CHARS_MAX + 1 });
  await rejected({ maxSegmentChars: 20000.5 });
  await rejected({ maxSegmentChars: '20000' });
  await rejected({ modelFamily: 5 });
  await rejected({ modelFamily: 'x'.repeat(101) });
  await rejected({ copilotEnabled: 'false' });
  await rejected({});
  await rejected(null);
  assert.equal(store.writes.length, 0);
});

test('关闭 Copilot：没有启用的千问文本模型时被拒绝，有则保存', async () => {
  const { store, admin, service } = createService();
  await assert.rejects(
    () => service.update({ copilotEnabled: false }),
    (error) => error instanceof ValidationError && error.fieldErrors.copilotEnabled === COPILOT_OFF_NEEDS_MODEL_MESSAGE
  );
  assert.equal(store.settings.copilotEnabled, true);

  admin.enable(1);
  await service.update({ copilotEnabled: false });
  assert.equal(store.settings.copilotEnabled, false);
});

test('启用 Copilot：自动停用全部千问文本模型，不影响其他类型的模型', async () => {
  const { store, admin, service } = createService();
  store.settings = { ...store.settings, copilotEnabled: false };
  admin.enable(1, 2, 3);
  await service.update({ copilotEnabled: true });
  assert.equal(store.settings.copilotEnabled, true);
  assert.deepEqual(admin.enabledIds(), [3]);
});

test('启用千问文本模型：正在使用 Copilot 时必须同意关闭，同意后一并关闭 Copilot', async () => {
  const { store, admin, service } = createService();
  await assert.rejects(
    () => service.setModelEnabled({ modelId: 1, isEnabled: true }),
    (error) => error instanceof ConflictError && error.message === COPILOT_ON_CONFLICT_MESSAGE
  );
  await assert.rejects(() => service.setModelEnabled({ modelId: 1, isEnabled: true, closeCopilot: 'yes' }), ConflictError);
  assert.deepEqual([store.settings.copilotEnabled, admin.enabledIds()], [true, []]);

  await service.setModelEnabled({ modelId: 1, isEnabled: true, closeCopilot: true });
  assert.deepEqual([store.settings.copilotEnabled, admin.enabledIds()], [false, [1]]);
});

test('启用千问文本模型：没能关闭 Copilot 时撤销启用并抛出原错误', async () => {
  const { store, admin, service } = createService();
  store.failWrites = true;
  await assert.rejects(() => service.setModelEnabled({ modelId: 1, isEnabled: true, closeCopilot: true }), /写入失败/);
  assert.deepEqual([store.settings.copilotEnabled, admin.enabledIds()], [true, []]);
});

test('千问文本模型：Copilot 已关闭时可以直接启用其他模型，停用最后一个模型被拒绝', async () => {
  const { store, admin, service } = createService();
  store.settings = { ...store.settings, copilotEnabled: false };
  admin.enable(1);

  await service.setModelEnabled({ modelId: 2, isEnabled: true });
  await service.setModelEnabled({ modelId: 1, isEnabled: false });
  assert.deepEqual(admin.enabledIds(), [2]);

  await assert.rejects(
    () => service.setModelEnabled({ modelId: 2, isEnabled: false }),
    (error) => error instanceof ValidationError && error.fieldErrors.isEnabled === LAST_TEXT_MODEL_MESSAGE
  );
  assert.deepEqual(admin.enabledIds(), [2]);
});

test('千问文本模型：使用 Copilot 时停用文本模型不受限制；非文本模型不受二选一规则影响；模型不存在时未找到', async () => {
  const { admin, service } = createService();
  await service.setModelEnabled({ modelId: 2, isEnabled: false });
  await service.setModelEnabled({ modelId: 3, isEnabled: true });
  assert.deepEqual(admin.enabledIds(), [3]);
  await assert.rejects(() => service.setModelEnabled({ modelId: 99, isEnabled: true }), NotFoundError);
  await assert.rejects(() => service.setModelEnabled({ modelId: 1, isEnabled: 'on' }), ValidationError);
});
