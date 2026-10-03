// ------------------------------------------------------------------------
// 名称：workbench-profile.test.mjs
// 说明：工作台“配置参数”步骤中的 DOM 测试：声音内容的四个开关（一行一个、模型不支持的置灰、至少开启一项），以及提示词相关参数：负向清单（默认清单说明、常用项一键加入、清空表示不要、恢复沿用）与提示词改写开关（开启、关闭、模型不支持时置灰）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom 加载组件库与 resources/workbench/profile.js，宿主的保存函数用假实现并记录调用；放在 ui-kit/test 是因为 npm test 只收集这里的页面测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createUiEnvironment } from './ui-environment.mjs';

const RESOURCES_ROOT = fileURLToPath(new URL('../../resources/', import.meta.url));
const DEFAULT_LIST = '不要字幕，不要水印';
const PRESETS = ['不要字幕', '不要水印', '不要人脸变形'];

let env;

afterEach(() => env?.close());

const EMPTY_VALUES = { modelId: null, aspectRatio: null, resolution: null, audioMode: null, audioElements: null, seed: null, durationSeconds: null, negativeList: null, promptExtend: null };

/** 一个视频模型；supportsPromptExtend 决定改写开关是否可用。 */
function makeModel(supportsPromptExtend) {
  return {
    id: 1,
    displayName: '假视频模型',
    providerName: '假服务商',
    aspectRatios: ['16:9'],
    resolutions: ['720P'],
    audioModes: ['none', 'native'],
    audioElements: ['dialogue', 'sfx'],
    supportsSeed: true,
    supportsPromptExtend,
    durationText: '2–10 秒',
    maxGroupSeconds: 10
  };
}

/** 建立页面并创建参数面板；返回页面、记录到的保存请求，以及可修改的作品级值。 */
function setup(supportsPromptExtend = true, work = {}) {
  env = createUiEnvironment();
  const { window } = env;
  const state = {
    catalog: { models: [makeModel(supportsPromptExtend)], promptDefaults: { negativeList: DEFAULT_LIST, negativePresets: PRESETS } },
    profile: {
      work: { ...EMPTY_VALUES, ...work },
      episode: { ...EMPTY_VALUES },
      effective: {
        values: { ...EMPTY_VALUES, ...work },
        sources: Object.fromEntries(Object.keys(EMPTY_VALUES).map((field) => [field, work[field] === undefined || work[field] === null ? 'none' : 'work']))
      }
    },
    group: null
  };
  const saved = [];
  const host = {
    getState: () => state,
    save: async (scope, changes) => {
      saved.push([scope, changes]);
      return { ok: true };
    }
  };
  window.eval(readFileSync(`${RESOURCES_ROOT}workbench/profile.js`, 'utf8'));
  const panel = window.aiProfile.create(host);
  env.document.body.append(panel.element);
  return { window, doc: env.document, saved, state, panel };
}

/** 页面里创建的对象来自 jsdom 的另一个运行环境，比较前先转成普通对象。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 当前负向清单字段里的所有文本（说明、输入框之外的文字）。 */
function fieldOf(doc, ariaLabel) {
  return doc.querySelector(`[aria-label="${ariaLabel}"]`).closest('.ui-field');
}

test('负向清单：没有设置时说明当前使用默认清单，常用项里已在清单中的置灰，点击其他项在默认清单后追加并保存', async () => {
  const { doc, saved } = setup();
  const field = fieldOf(doc, '负向清单');
  assert.match(field.textContent, new RegExp(`当前生效：${DEFAULT_LIST}（未设置，使用默认值）`));
  assert.equal(field.querySelector('textarea').value, '', '本级没有设置时输入框为空');

  const chips = [...field.querySelectorAll('.wb-profile__chips button')];
  assert.deepEqual(chips.map((chip) => chip.textContent.trim()), PRESETS.map((preset) => `＋${preset}`));
  assert.deepEqual(chips.map((chip) => chip.disabled), [true, true, false]);
  chips[2].click();
  await flush();
  assert.deepEqual(plain(saved), [['work', { negativeList: `${DEFAULT_LIST}，不要人脸变形` }]]);
});

test('负向清单：本级没有设置时清空输入框不算修改；设置过再清空保存空串（明确不要）；有设置时出现“恢复沿用上一级”', async () => {
  const unset = setup();
  const box = unset.doc.querySelector('textarea[aria-label="负向清单"]');
  box.dispatchEvent(new unset.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(plain(unset.saved), []);
  assert.equal(fieldOf(unset.doc, '负向清单').querySelector('.wb-profile__restore'), null);
  env.close();

  const set = setup(true, { negativeList: '不要水印' });
  const field = fieldOf(set.doc, '负向清单');
  assert.match(field.textContent, /当前生效：不要水印（作品默认）/);
  const textarea = field.querySelector('textarea');
  assert.equal(textarea.value, '不要水印');
  textarea.value = '';
  textarea.dispatchEvent(new set.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(plain(set.saved), [['work', { negativeList: '' }]]);

  const restore = [...field.querySelectorAll('.wb-profile__restore button')].find((button) => button.textContent.includes('恢复沿用上一级'));
  assert.ok(restore);
  restore.click();
  await flush();
  assert.deepEqual(plain(set.saved.at(-1)), ['work', { negativeList: null }]);
});

test('提示词改写：下拉选择开启或关闭并保存；沿用时说明平台默认开启；模型不支持时置灰并说明原因', async () => {
  const supported = setup();
  const field = fieldOf(supported.doc, '提示词改写');
  assert.match(field.textContent, /当前生效：平台默认（开启）/);
  supported.doc.querySelector('[aria-label="提示词改写"]').click();
  const closeOption = [...supported.doc.querySelectorAll('.ui-select__option')].find((option) => option.textContent.trim() === '关闭');
  closeOption.click();
  await flush();
  assert.deepEqual(plain(supported.saved), [['work', { promptExtend: false }]]);
  env.close();

  const unsupported = setup(false);
  const disabled = fieldOf(unsupported.doc, '提示词改写');
  assert.match(disabled.textContent, /所选模型不支持提示词改写开关/);
  assert.ok(unsupported.doc.querySelector('[aria-label="提示词改写"]').disabled || unsupported.doc.querySelector('[aria-label="提示词改写"]').classList.contains('ui-is-disabled'));
});

test('声音内容：每个内容一个开关、一行一个，模型不支持的置灰；关闭一项保存剩余项，最后一项不能关闭', async () => {
  const { doc, saved } = setup();
  const field = fieldOf(doc, '声音内容');
  const rows = [...field.querySelectorAll('.ui-switch-row')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.ui-switch-row__label').textContent),
    ['对白', '旁白（所选模型不支持）', '音效', '配乐（所选模型不支持）']
  );
  const switches = rows.map((row) => row.querySelector('[role="switch"]'));
  assert.deepEqual(switches.map((item) => item.disabled), [false, true, false, true]);
  assert.deepEqual(switches.map((item) => item.getAttribute('aria-checked')), ['true', 'false', 'true', 'false']);
  assert.equal(field.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length, 0, '不再用复选框');

  switches[0].click();
  await flush();
  assert.deepEqual(plain(saved), [['work', { audioElements: ['sfx'] }]]);
  env.close();

  const single = setup(true, { audioElements: ['dialogue'] });
  const last = fieldOf(single.doc, '声音内容').querySelector('[role="switch"]');
  last.click();
  await flush();
  assert.deepEqual(plain(single.saved), [], '至少保留一项，不保存');
  assert.match(single.doc.querySelector('.wb-message').textContent, /至少开启一项/);
});

test('生效参数：已设置的值原样使用，未设置的负向清单与改写开关来源为“默认”；模型不支持改写开关却设置了时记为问题', () => {
  const { window } = setup(false, { promptExtend: true });
  const catalog = { models: [makeModel(false)] };
  const profile = { effective: { values: { ...EMPTY_VALUES, promptExtend: true }, sources: Object.fromEntries(Object.keys(EMPTY_VALUES).map((field) => [field, 'none'])) } };
  const resolved = window.aiProfile.resolve(catalog, profile);
  assert.equal(resolved.values.promptExtend, true);
  assert.deepEqual([resolved.sources.negativeList, resolved.sources.promptExtend], ['default', 'work'.replace('work', 'none')]);
  assert.match(resolved.issues.promptExtend, /不支持提示词改写开关/);

  const supported = window.aiProfile.resolve({ models: [makeModel(true)] }, { effective: { values: { ...EMPTY_VALUES }, sources: Object.fromEntries(Object.keys(EMPTY_VALUES).map((field) => [field, 'none'])) } });
  assert.deepEqual([supported.sources.negativeList, supported.sources.promptExtend, supported.issues.promptExtend], ['default', 'default', undefined]);
});
