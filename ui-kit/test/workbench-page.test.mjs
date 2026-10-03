// ------------------------------------------------------------------------
// 名称：workbench-page.test.mjs
// 说明：生成工作台页的 DOM 测试：顶部上下文栏（项目、作品、分集下拉）、三栏工作区、右栏三个步骤页签、提交只在“检查并提交”步骤、底部队列，以及页面里没有原生表单控件、同样功能的按钮不重复出现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom 加载组件库与 resources/workbench 下的脚本，宿主请求用假的 hostBridge 应答；jsdom 没有排版，布局与滚动靠浏览器手工验证；放在 ui-kit/test 是因为 npm test 只收集这里的页面测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createUiEnvironment } from './ui-environment.mjs';

const RESOURCES_ROOT = fileURLToPath(new URL('../../resources/', import.meta.url));
/** 工作台页按依赖顺序加载的脚本（相对 resources 目录）。 */
const PAGE_SCRIPTS = [
  'shared/page-format.js',
  'workbench/step-tabs.js',
  'workbench/bindings.js',
  'workbench/profile.js',
  'workbench/submit-panel.js',
  'workbench/player.js',
  'workbench/versions.js',
  'workbench/workbench.js'
];
const WAIT_STEP_MS = 10;
const WAIT_LIMIT_MS = 1500;
const EMPTY_VALUES = { modelId: null, aspectRatio: null, resolution: null, audioMode: null, audioElements: null, seed: null, durationSeconds: null, negativeList: null, promptExtend: null };

let env;

afterEach(() => env?.close());

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立，超时则让断言失败。 */
async function waitFor(condition, message) {
  for (let elapsed = 0; elapsed < WAIT_LIMIT_MS; elapsed += WAIT_STEP_MS) {
    if (condition()) return;
    await wait(WAIT_STEP_MS);
  }
  assert.fail(message);
}

/** 构造一个镜头组：三个镜头，出场实体按参数指定。 */
function makeGroup(id, entities) {
  return {
    id,
    seq: id,
    shots: [1, 2, 3].map((seq) => ({ id: id * 10 + seq, seq, sceneLabel: `第 ${id} 场`, shotSize: '中景', action: `镜头 ${seq} 的画面`, durationSeconds: 2, soundCount: 0 })),
    totalSeconds: 6,
    entities,
    jobs: [],
    overrides: { ...EMPTY_VALUES },
    selectedResultId: null,
    staleNote: null
  };
}

/** 一个视频模型。 */
const MODEL = {
  id: 1,
  displayName: '假视频模型',
  providerName: '假服务商',
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['480P', '720P'],
  audioModes: ['none', 'native'],
  audioElements: ['dialogue', 'narration', 'sfx', 'music'],
  supportsSeed: true,
  supportsPromptExtend: true,
  durationText: '2–10 秒',
  maxGroupSeconds: 10
};

/** 建立工作台页：组件库、假的宿主通信桥与页面脚本；返回页面、记录到的请求和可用的辅助函数。 */
async function setup() {
  env = createUiEnvironment();
  const { window, document } = env;
  document.body.innerHTML = '<header class="page-header"><div id="page-toolbar"></div></header><div id="app"></div>';
  const requests = [];
  const entities = [
    { id: 1, name: '团团', kindLabel: '角色', bound: false },
    { id: 2, name: '旧公寓客厅', kindLabel: '场景', bound: true },
    { id: 3, name: '钥匙', kindLabel: '道具', bound: false }
  ];
  const catalog = {
    works: [
      { id: 1, name: '两只小猫讲故事', projectName: '小猫项目', episodes: [{ episodeId: 11, seq: 1, title: '相遇', display: 'approved', shotCount: 6 }] },
      { id: 2, name: '城市夜行', projectName: '夜行项目', episodes: [{ episodeId: 21, seq: 1, title: '', display: 'approved', shotCount: 3 }] }
    ],
    models: [MODEL],
    promptDefaults: { negativeList: '不要字幕', negativePresets: ['不要字幕'] }
  };
  const view = { workId: 1, episodeId: 11, episodeTitle: '相遇', canGenerate: true, blockReason: null, groupMaxSeconds: 10, groups: [makeGroup(1, entities), makeGroup(2, [entities[1]])] };
  const profile = { work: { ...EMPTY_VALUES }, episode: { ...EMPTY_VALUES }, effective: { values: { ...EMPTY_VALUES }, sources: Object.fromEntries(Object.keys(EMPTY_VALUES).map((field) => [field, 'none'])) } };
  const bindingView = {
    entities: [
      { entityId: 1, name: '团团', kind: 'character', kindLabel: '角色', visual: [], voice: [] },
      { entityId: 2, name: '旧公寓客厅', kind: 'scene', kindLabel: '场景', visual: [{ id: 5, assetId: 9, assetName: '客厅图', isPrimary: true, thumbnail: null, durationSeconds: null }], voice: [] },
      { entityId: 3, name: '钥匙', kind: 'prop', kindLabel: '道具', visual: [], voice: [] }
    ],
    visualAssets: { character: [], scene: [], prop: [], effect: [] },
    voiceAssets: []
  };
  const preview = (groupIds) => ({
    groups: groupIds.map((groupId) => ({
      groupId,
      seq: groupId,
      shotCount: 3,
      totalSeconds: 6,
      durationSeconds: 6,
      firstFrame: 'none',
      prompt: '提示词',
      negativeList: null,
      promptExtend: null,
      referenceImageCount: 0,
      referenceAudioCount: 0,
      audioMode: 'native',
      audioElements: ['dialogue'],
      seed: null,
      blocking: [],
      warnings: []
    }))
  });
  window.hostBridge = {
    request: async (name, payload) => {
      requests.push([name, payload]);
      if (name === 'workbench.catalog') return catalog;
      if (name === 'workbench.episode') return view;
      if (name === 'workbench.profile') return profile;
      if (name === 'bindings.view') return bindingView;
      if (name === 'workbench.preview') return preview(payload.groupIds);
      throw new Error(`测试里没有准备这个请求的应答：${name}`);
    },
    onEvent: () => undefined
  };
  window.aiStage = { open: () => undefined, closeMissing: () => undefined };
  window.aiTailFrames = { sync: async () => undefined };
  for (const file of PAGE_SCRIPTS) window.eval(readFileSync(`${RESOURCES_ROOT}${file}`, 'utf8'));
  await waitFor(() => document.querySelector('.wb-workspace') !== null, '工作台没有渲染出三栏工作区');
  await waitFor(() => document.querySelector('.wb-entity-row') !== null, '绑定面板没有渲染出实体');
  return { window, document, requests };
}

/** 页面里所有按钮的文字。 */
const buttonTexts = (document) => [...document.querySelectorAll('button')].map((button) => button.textContent.trim());

test('顶部上下文栏：项目、作品、分集三个下拉和只读的当前生成配置，工具行不放任何控件', async () => {
  const { document } = await setup();
  const triggers = [...document.querySelectorAll('.wb-context .ui-select__trigger')];
  assert.deepEqual(
    triggers.map((trigger) => trigger.getAttribute('aria-label')),
    ['选择项目', '选择作品', '选择分集']
  );
  assert.deepEqual(
    triggers.map((trigger) => trigger.textContent.trim()),
    ['小猫项目', '两只小猫讲故事', '第 1 集 相遇（已确认）']
  );
  assert.match(document.querySelector('.wb-context__summary').textContent, /假视频模型 · 16:9 · 720P/);
  assert.equal(document.querySelector('#page-toolbar').children.length, 0);
});

test('切换项目时落到所选项目下作品的第一集并重新读取', async () => {
  const { document, requests } = await setup();
  document.querySelector('[aria-label="选择项目"]').click();
  const option = [...document.querySelectorAll('.ui-select__option')].find((item) => item.textContent.trim() === '夜行项目');
  option.click();
  await waitFor(() => requests.some(([name, payload]) => name === 'workbench.episode' && payload.workId === 2 && payload.episodeId === 21), '没有读取新集的视图');
  assert.equal(document.querySelector('[aria-label="选择作品"]').textContent.trim(), '城市夜行');
});

test('三栏工作区：镜头组列表、镜头组详情、右栏步骤页签；选中的镜头组有 aria-current，点击切换详情', async () => {
  const { document } = await setup();
  const panels = [...document.querySelectorAll('.wb-workspace > .wb-panel')];
  assert.equal(panels.length, 3);
  assert.ok(panels[0].classList.contains('wb-groups') && panels[1].classList.contains('wb-detail') && panels[2].classList.contains('wb-steps'));

  const items = [...document.querySelectorAll('.wb-group-item')];
  assert.equal(items.length, 2);
  assert.equal(items[0].getAttribute('aria-current'), 'true');
  assert.match(document.querySelector('.wb-detail .wb-detail-title').textContent, /第 1 组/);
  assert.equal(document.querySelectorAll('.wb-shot').length, 3, '详情里列出组内全部镜头');
  assert.match(items[0].textContent, /需绑定|待绑定/);

  items[1].click();
  assert.match(document.querySelector('.wb-detail .wb-detail-title').textContent, /第 2 组/);
  assert.equal(document.querySelector('.wb-group-item[aria-current="true"]').textContent.includes('第 2 组'), true);
});

test('步骤页签：三步带序号与状态副文字，下一步按钮切换步骤，完成的步骤序号变对勾', async () => {
  const { document } = await setup();
  const tabs = [...document.querySelectorAll('.wb-steps__tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.querySelector('.wb-steps__tab-title').textContent),
    ['1 绑定素材', '✓ 配置参数', '3 检查并提交']
  );
  assert.equal(tabs[0].querySelector('.wb-steps__tab-note').textContent, '2 项未绑定');
  assert.equal(tabs[1].querySelector('.wb-steps__tab-note').textContent, '16:9 · 720P');
  assert.ok(tabs[1].classList.contains('wb-steps__tab--done'));
  assert.equal(tabs[1].querySelector('.wb-steps__tab-title').textContent, '✓ 配置参数');
  assert.equal(tabs[2].querySelector('.wb-steps__tab-note').textContent, '2 组待提交');

  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  const next = [...document.querySelectorAll('.wb-steps__footer button')].find((button) => button.textContent.includes('下一步：配置参数'));
  next.click();
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelectorAll('.wb-steps__panel:not([hidden])').length, 1);
});

test('绑定素材：只列所选镜头组出场的实体，一个实体一行（状态加按钮），顶部是该组的绑定进度；切换镜头组随之变化', async () => {
  const { document } = await setup();
  const rows = () => [...document.querySelectorAll('.wb-entity-row')];
  assert.match(document.querySelector('.wb-entity-heading').textContent, /本组实体（3）/);
  assert.deepEqual(
    rows().map((row) => row.querySelector('.wb-entity-state > span').textContent),
    ['⚠ 未绑定', '✓ 已绑定', '⚠ 未绑定']
  );
  assert.deepEqual(
    rows().map((row) => row.querySelector('button').textContent.trim()),
    ['选择资产', '管理', '选择资产']
  );
  assert.equal(document.querySelector('.wb-bind__head span').textContent, '1 / 3 已绑定');
  assert.equal(document.querySelector('.wb-progress').getAttribute('aria-valuenow'), '33');
  assert.match(document.querySelector('.wb-steps__context').textContent, /第 1 组.*第 1 步 \/ 3：绑定素材/);

  document.querySelectorAll('.wb-group-item')[1].click();
  assert.equal(rows().length, 1);
  assert.equal(document.querySelector('.wb-bind__head span').textContent, '✓ 已全部绑定');
  assert.equal(document.querySelectorAll('.wb-steps__tab')[0].querySelector('.wb-steps__tab-note').textContent, '全部已绑定');
  assert.ok(document.querySelectorAll('.wb-steps__tab')[0].classList.contains('wb-steps__tab--done'));
});

test('点实体行的“选择资产”弹出这个实体的绑定页（形象、音色参考与新建资产），不在列表里堆按钮', async () => {
  const { document } = await setup();
  document.querySelectorAll('.wb-entity-row')[0].querySelector('button').click();
  const dialogTitle = document.querySelector('.ui-dialog__title');
  assert.ok(dialogTitle && dialogTitle.textContent.includes('绑定资产：团团（角色）'));
  const dialogTexts = [...document.querySelectorAll('.ui-dialog button')].map((button) => button.textContent.trim());
  assert.ok(dialogTexts.includes('选择资产') && dialogTexts.includes('新建资产') && dialogTexts.includes('选择音色'));
  assert.equal(
    [...document.querySelectorAll('.wb-entity-list button')].some((button) => button.textContent.includes('新建资产')),
    false
  );
});

test('每一步底部都有固定的操作：前两步是“上一步”“下一步”，第三步是“上一步”和“提交所选”', async () => {
  const { document } = await setup();
  const footerTexts = () => [...document.querySelectorAll('.wb-steps__panel:not([hidden]) .wb-steps__actions button')].map((button) => button.textContent.trim());
  assert.deepEqual(footerTexts(), ['下一步：配置参数 →']);
  document.querySelectorAll('.wb-steps__tab')[1].click();
  assert.deepEqual(footerTexts(), ['← 上一步', '下一步：检查并提交 →']);
  document.querySelectorAll('.wb-steps__tab')[2].click();
  assert.deepEqual(footerTexts(), ['← 上一步', '提交所选（2）']);
  [...document.querySelectorAll('.wb-steps__panel:not([hidden]) .wb-steps__actions button')][0].click();
  assert.equal(document.querySelectorAll('.wb-steps__tab')[1].getAttribute('aria-selected'), 'true');
});

test('配置参数：应用范围是三个选项的分段开关，声音内容是四个开关，页面里没有原生下拉与原生复选框、单选框', async () => {
  const { document } = await setup();
  document.querySelectorAll('.wb-steps__tab')[1].click();
  assert.deepEqual(
    [...document.querySelectorAll('.wb-profile__scope [role="radio"]')].map((radio) => radio.textContent.trim()),
    ['作品默认', '本集', '本镜头组']
  );
  const switches = [...document.querySelectorAll('.wb-switch-list [role="switch"]')];
  assert.equal(switches.length, 4);
  assert.deepEqual(
    [...document.querySelectorAll('.wb-switch-list .ui-switch-row__label')].map((label) => label.textContent),
    ['对白', '旁白', '音效', '配乐']
  );
  assert.equal(document.querySelectorAll('select, input[type="checkbox"], input[type="radio"]').length, 0);
});

test('提交只在“检查并提交”步骤里：详情里没有提交按钮，步骤里默认勾选未完成的镜头组，点“提交所选”才提交', async () => {
  const { document, requests } = await setup();
  assert.equal(
    [...document.querySelectorAll('.wb-detail button')].some((button) => button.textContent.includes('提交')),
    false,
    '镜头组详情里不放提交按钮'
  );
  document.querySelectorAll('.wb-steps__tab')[2].click();
  await waitFor(() => [...document.querySelectorAll('.wb-submit__footer button')].some((button) => button.textContent.includes('提交所选（2）')), '提交步骤没有默认勾选未完成的镜头组');
  assert.equal(requests.some(([name]) => name === 'workbench.submit'), false, '没有点“提交所选”就不能提交');
});

test('同样功能的按钮不重复出现：没有批量栏、工具栏的参数按钮、“修改本组参数”、“去绑定”和“实体绑定”入口', async () => {
  const { document } = await setup();
  const texts = buttonTexts(document);
  for (const gone of ['生成参数', '修改本组参数', '提交未完成的镜头组', '查看分镜脚本']) {
    assert.equal(
      texts.some((text) => text.includes(gone)),
      false,
      `不应再有“${gone}”按钮`
    );
  }
  assert.equal(texts.filter((text) => text === '编辑镜头').length, 1);
  assert.equal(texts.some((text) => text.startsWith('去绑定')), false, '出场实体概览只是文字，不再有“去绑定”按钮');
  assert.equal(texts.filter((text) => text === '按名称自动匹配').length, 1);
  assert.equal(document.querySelectorAll('.wb-splitter, .wb-tree, .wb-inspector, .wb-toolbar').length, 0, '旧的分隔条、镜头树、检查器与工具栏已移除');
});

test('底部队列：默认展开，标题行的按钮收起与展开任务表，aria-expanded 同步', async () => {
  const { document } = await setup();
  const toggle = document.querySelector('.wb-queue__header button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.wb-queue__body').hidden, false);
  assert.match(document.querySelector('.wb-queue__title').textContent, /队列与结果.*生成中 0/);
  toggle.click();
  const collapsed = document.querySelector('.wb-queue__header button');
  assert.equal(collapsed.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.wb-queue__body').hidden, true);
});
