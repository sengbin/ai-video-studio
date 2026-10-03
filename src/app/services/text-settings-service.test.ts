// ------------------------------------------------------------------------
// 名称：text-settings-service.test.ts
// 说明：文本模型设置服务的自动化测试：设置视图与可选模型列表、修改校验、作品单独选择文本模型的候选与保存。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存中的设置存储、Copilot 模型清单、服务商文本模型与作品选择，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../../domain/errors';
import { ModelRecord, UsableModel } from '../../domain/models/model-provider';
import { TextGenerationSettingsStore, TextModelCatalog, TextModelFamilies } from '../../domain/ports/text-generation-settings-store';
import { WorkTextModelRepository } from '../../domain/ports/work-text-model-repository';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  TextGenerationSettings,
  TextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';
import {
  COPILOT_DISABLED_MESSAGE,
  DEFAULT_FALLBACK_HINT,
  MODEL_MISSING_HINT,
  MODEL_NOT_ENABLED_MESSAGE,
  NO_TEXT_MODEL_NOTE,
  TextModelSource,
  TextSettingsService
} from './text-settings-service';

const QIANWEN_KEY = 'model:fake/fake-text';
const QIANWEN_LABEL = '假服务商 · 假文本模型';

/** 内存中的设置存储。 */
class MemoryStore implements TextGenerationSettingsStore {
  settings: TextGenerationSettings = { copilotEnabled: true, defaultModel: 'copilot:', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } };
  readonly writes: TextGenerationSettingsPatch[] = [];

  read(): TextGenerationSettings {
    return this.settings;
  }

  async write(patch: TextGenerationSettingsPatch): Promise<void> {
    this.writes.push(patch);
    this.settings = {
      copilotEnabled: patch.copilotEnabled ?? this.settings.copilotEnabled,
      defaultModel: patch.defaultModel ?? this.settings.defaultModel,
      novelSplit: {
        mode: patch.splitMode ?? this.settings.novelSplit.mode,
        maxSegmentChars: patch.maxSegmentChars ?? this.settings.novelSplit.maxSegmentChars
      }
    };
  }
}

/** 内存中的作品选择。 */
class MemoryWorkModels implements WorkTextModelRepository {
  readonly saved = new Map<number, string>();

  find(workId: number): string | null {
    return this.saved.get(workId) ?? null;
  }

  save(workId: number, modelKey: string | null): void {
    if (modelKey === null) this.saved.delete(workId);
    else this.saved.set(workId, modelKey);
  }
}

/** 服务商文本模型：可以切换是否已启用。 */
class MemoryModels implements TextModelSource {
  enabled = false;

  listSelectableTextModels(): UsableModel[] {
    const model = { code: 'fake-text', displayName: '假文本模型', kind: 'text' } as ModelRecord;
    return this.enabled ? [{ model, providerCode: 'fake', providerName: '假服务商' }] : [];
  }
}

function createService(families: TextModelFamilies = { families: ['claude-sonnet', 'gpt-4o'] }) {
  const store = new MemoryStore();
  const models = new MemoryModels();
  const workModels = new MemoryWorkModels();
  const catalog: TextModelCatalog = { listFamilies: async () => families };
  return { store, models, workModels, service: new TextSettingsService(store, catalog, models, workModels) };
}

test('设置视图：默认启用 Copilot，列表是 Copilot 自动与各家族，字数范围随视图返回', async () => {
  const { service } = createService();
  assert.deepEqual(await service.getView(), {
    copilotEnabled: true,
    defaultModel: 'copilot:',
    choices: [
      { key: 'copilot:', label: 'Copilot · 自动' },
      { key: 'copilot:claude-sonnet', label: 'Copilot · claude-sonnet' },
      { key: 'copilot:gpt-4o', label: 'Copilot · gpt-4o' }
    ],
    splitMode: 'chapter',
    maxSegmentChars: 20000,
    segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
    modelNote: null,
    engineNote: null
  });
});

test('设置视图：已启用的服务商文本模型出现在列表中，停用后不再出现', async () => {
  const { models, service } = createService({ families: [] });
  models.enabled = true;
  assert.deepEqual((await service.getView()).choices.map((choice) => choice.key), ['copilot:', QIANWEN_KEY]);
  models.enabled = false;
  assert.deepEqual((await service.getView()).choices.map((choice) => choice.key), ['copilot:']);
});

test('设置视图：关闭 Copilot 后它的模型不再出现，不再查询 Copilot；没有任何可选模型时给出警告', async () => {
  const { store, models, service } = createService({ families: ['gpt-4o'], unavailableReason: '不应出现' });
  store.settings = { ...store.settings, copilotEnabled: false };
  const none = await service.getView();
  assert.deepEqual([none.choices, none.defaultModel, none.modelNote, none.engineNote], [[], '', null, NO_TEXT_MODEL_NOTE]);

  models.enabled = true;
  const view = await service.getView();
  assert.deepEqual(view.choices, [{ key: QIANWEN_KEY, label: QIANWEN_LABEL }]);
  assert.deepEqual([view.defaultModel, view.engineNote], [QIANWEN_KEY, null]);
});

test('设置视图：默认模型已不可用时显示实际使用的模型并提示；Copilot 不可用或所选家族不存在时说明原因', async () => {
  const { store, models, service } = createService();
  store.settings = { ...store.settings, copilotEnabled: false, defaultModel: 'copilot:gpt-4o' };
  models.enabled = true;
  const fallback = await service.getView();
  assert.deepEqual([fallback.defaultModel, fallback.modelNote], [QIANWEN_KEY, DEFAULT_FALLBACK_HINT(QIANWEN_LABEL)]);

  const none = createService({ families: [], unavailableReason: '未检测到可用的 Copilot 模型。' });
  assert.equal((await none.service.getView()).modelNote, '未检测到可用的 Copilot 模型。');

  const missing = createService({ families: ['claude-sonnet'] });
  missing.store.settings = { ...missing.store.settings, defaultModel: 'copilot:gpt-4o' };
  const view = await missing.service.getView();
  assert.equal(view.modelNote, MODEL_MISSING_HINT);
  assert.deepEqual([view.defaultModel, view.choices.at(-1)?.label], ['copilot:gpt-4o', 'Copilot · gpt-4o（不可用）']);
});

test('保存设置：只写出现的项，默认模型去除空白，下次读取即为新值', async () => {
  const { store, models, service } = createService();
  models.enabled = true;
  await service.update({ defaultModel: ` ${QIANWEN_KEY} ` });
  await service.update({ splitMode: 'length', maxSegmentChars: 30000 });
  await service.update({ copilotEnabled: false });
  assert.deepEqual(store.writes, [{ defaultModel: QIANWEN_KEY }, { splitMode: 'length', maxSegmentChars: 30000 }, { copilotEnabled: false }]);
  const view = await service.getView();
  assert.deepEqual([view.defaultModel, view.splitMode, view.maxSegmentChars, view.copilotEnabled], [QIANWEN_KEY, 'length', 30000, false]);
});

test('保存设置：不合法的值、关闭的 Copilot、未启用的模型被拒绝且不写入', async () => {
  const { store, service } = createService();
  const rejected = async (patch: unknown, message?: string) =>
    assert.rejects(
      () => service.update(patch),
      (error) => error instanceof ValidationError && (message === undefined || Object.values(error.fieldErrors).includes(message))
    );

  await rejected({ splitMode: 'paragraph' });
  await rejected({ maxSegmentChars: SEGMENT_CHARS_MIN - 1 });
  await rejected({ maxSegmentChars: '20000' });
  await rejected({ copilotEnabled: 'false' });
  await rejected({ defaultModel: 'gpt-4o' });
  await rejected({ defaultModel: QIANWEN_KEY }, MODEL_NOT_ENABLED_MESSAGE);
  await rejected({});
  await rejected(null);
  assert.equal(store.writes.length, 0);

  store.settings = { ...store.settings, copilotEnabled: false };
  await rejected({ defaultModel: 'copilot:gpt-4o' }, COPILOT_DISABLED_MESSAGE);
  assert.equal(store.writes.length, 0);
});

test('作品的文本模型：候选与默认名称随设置变化，选择只在仍可用时生效', async () => {
  const { models, workModels, service } = createService({ families: ['gpt-4o'] });
  models.enabled = true;

  const fresh = await service.getWorkState(null);
  assert.deepEqual([fresh.defaultLabel, fresh.selectedKey, fresh.choices.map((choice) => choice.key)], ['Copilot · 自动', null, ['copilot:', 'copilot:gpt-4o', QIANWEN_KEY]]);

  service.setWorkModel(7, QIANWEN_KEY);
  assert.equal(workModels.find(7), QIANWEN_KEY);
  assert.equal((await service.getWorkState(7)).selectedKey, QIANWEN_KEY);
  assert.equal((await service.getWorkState(8)).selectedKey, null);

  // 模型被停用后，作品的选择不再出现在候选中，沿用默认；记录保留，重新启用后恢复。
  models.enabled = false;
  assert.equal((await service.getWorkState(7)).selectedKey, null);
  models.enabled = true;
  assert.equal((await service.getWorkState(7)).selectedKey, QIANWEN_KEY);

  service.setWorkModel(7, null);
  assert.equal(workModels.find(7), null);
});

test('作品的文本模型：选用不可用的模型被拒绝', async () => {
  const { store, workModels, service } = createService();
  assert.throws(() => service.setWorkModel(1, QIANWEN_KEY), (error) => error instanceof ValidationError && error.fieldErrors.textModel === MODEL_NOT_ENABLED_MESSAGE);
  assert.throws(() => service.setWorkModel(1, 'bad'), ValidationError);
  store.settings = { ...store.settings, copilotEnabled: false };
  assert.throws(() => service.setWorkModel(1, 'copilot:gpt-4o'), (error) => error instanceof ValidationError && error.fieldErrors.textModel === COPILOT_DISABLED_MESSAGE);
  assert.equal(workModels.find(1), null);
});
