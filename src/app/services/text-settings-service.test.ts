// ------------------------------------------------------------------------
// 名称：text-settings-service.test.ts
// 说明：文本生成设置服务与最近项目记录的自动化测试：设置视图、修改校验、失效记录清除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存中的设置存储、模型清单与键值状态，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../../domain/errors';
import { Project } from '../../domain/models/project';
import { TextGenerationSettingsStore, TextModelCatalog, TextModelFamilies } from '../../domain/ports/text-generation-settings-store';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  TextGenerationSettings,
  TextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';
import { KeyValueState, RECENT_PROJECT_STATE_KEY, RecentProjectStore } from './recent-project-store';
import { MODEL_MISSING_HINT, TextSettingsService } from './text-settings-service';

/** 内存中的设置存储。 */
class MemoryStore implements TextGenerationSettingsStore {
  settings: TextGenerationSettings = { modelFamily: '', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } };
  readonly writes: TextGenerationSettingsPatch[] = [];

  read(): TextGenerationSettings {
    return this.settings;
  }

  async write(patch: TextGenerationSettingsPatch): Promise<void> {
    this.writes.push(patch);
    this.settings = {
      modelFamily: patch.modelFamily ?? this.settings.modelFamily,
      novelSplit: {
        mode: patch.splitMode ?? this.settings.novelSplit.mode,
        maxSegmentChars: patch.maxSegmentChars ?? this.settings.novelSplit.maxSegmentChars
      }
    };
  }
}

function createService(models: TextModelFamilies) {
  const store = new MemoryStore();
  const catalog: TextModelCatalog = { listFamilies: async () => models };
  return { store, service: new TextSettingsService(store, catalog) };
}

test('设置视图：默认设置、可选模型与字数范围', async () => {
  const { service } = createService({ families: ['claude-sonnet', 'gpt-4o'] });
  assert.deepEqual(await service.getView(), {
    modelFamily: '',
    splitMode: 'chapter',
    maxSegmentChars: 20000,
    segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
    families: ['claude-sonnet', 'gpt-4o'],
    modelNote: null
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

test('保存设置：只写出现的项，模型名去除空白，下次读取即为新值', async () => {
  const { store, service } = createService({ families: ['gpt-4o'] });
  await service.update({ modelFamily: ' gpt-4o ' });
  await service.update({ splitMode: 'length', maxSegmentChars: 30000 });
  assert.deepEqual(store.writes, [{ modelFamily: 'gpt-4o' }, { splitMode: 'length', maxSegmentChars: 30000 }]);
  const view = await service.getView();
  assert.deepEqual([view.modelFamily, view.splitMode, view.maxSegmentChars], ['gpt-4o', 'length', 30000]);
});

test('保存设置：不合法的值被拒绝且不写入', async () => {
  const { store, service } = createService({ families: [] });
  const rejected = async (patch: unknown) =>
    assert.rejects(() => service.update(patch), (error) => error instanceof ValidationError);

  await rejected({ splitMode: 'paragraph' });
  await rejected({ maxSegmentChars: SEGMENT_CHARS_MIN - 1 });
  await rejected({ maxSegmentChars: SEGMENT_CHARS_MAX + 1 });
  await rejected({ maxSegmentChars: 20000.5 });
  await rejected({ maxSegmentChars: '20000' });
  await rejected({ modelFamily: 5 });
  await rejected({ modelFamily: 'x'.repeat(101) });
  await rejected({});
  await rejected(null);
  assert.equal(store.writes.length, 0);
});

/** 内存中的键值状态。 */
class MemoryState implements KeyValueState {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

test('最近项目：记录后可读取；项目被删除后视为没有并清除记录', () => {
  const state = new MemoryState();
  const projects = new Map<number, Project>([[1, { id: 1, name: '甲' } as Project]]);
  const store = new RecentProjectStore(state, (id) => projects.get(id));

  assert.equal(store.get(), undefined);
  store.set(1);
  assert.equal(store.get()?.name, '甲');

  projects.delete(1);
  assert.equal(store.get(), undefined);
  assert.equal(state.values.has(RECENT_PROJECT_STATE_KEY), false);

  state.values.set(RECENT_PROJECT_STATE_KEY, '不是数字');
  assert.equal(store.get(), undefined);
});
