// ------------------------------------------------------------------------
// 名称：asset-list.test.mjs
// 说明：资产列表页的 DOM 测试：新建时先选择上传还是 AI 生成，生成来源的行有生成相关按钮，上传来源的行没有；两种来源之间的切换请求，以及还没有上传文件时改用上传会打开上传表单。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom 加载组件库与 resources/asset-list/asset-list.js，宿主请求、表单与版本层用假实现并记录调用；放在 ui-kit/test 是因为 npm test 只收集这里的页面测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createUiEnvironment, fire } from './ui-environment.mjs';

const RESOURCES_ROOT = fileURLToPath(new URL('../../resources/', import.meta.url));

let env;

afterEach(() => env?.close());

/** 一条资产记录，字段与宿主的列表行一致。 */
function makeAsset(overrides) {
  return {
    id: 1,
    kind: 'character',
    name: '林夏',
    categoryId: null,
    attributes: {},
    composition: '',
    style: null,
    promptZh: '提示词',
    promptEn: '',
    promptStatus: 'none',
    promptError: null,
    isPromptOutdated: false,
    hasUngeneratedChanges: false,
    availability: { available: true, reason: null },
    fileSource: 'generated',
    fileCount: 0,
    uploadFileCount: 0,
    episodeCount: 0,
    durationSeconds: null,
    thumbnail: null,
    generation: { versionCount: 0, latest: null, latestSucceeded: null, adoptedVersion: null },
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides
  };
}

/** 建立页面并加载脚本；返回页面、记录到的请求与表单调用。 */
async function setup(assets) {
  env = createUiEnvironment();
  const { window, document } = env;
  document.body.innerHTML = '<div id="page-toolbar"></div><div id="app"></div>';
  const requests = [];
  const forms = [];
  window.hostBridge = {
    request: async (name, payload) => {
      requests.push([name, payload]);
      if (name === 'assets.load') return { kind: 'character', assets, categories: [] };
      if (name === 'assets.takePending') return { request: undefined };
      return { switched: true };
    },
    onEvent: () => undefined
  };
  window.pageFormat = { formatRelativeTime: () => '刚刚' };
  window.aiForm = {
    open: async (options) => {
      forms.push(options);
    }
  };
  window.aiAssetGenerate = { open: () => undefined };
  window.aiAssetVersions = { open: () => undefined, refresh: async () => undefined, viewImage: () => undefined };
  window.aiAssetCategories = { open: () => undefined, refresh: () => undefined };
  window.eval(readFileSync(`${RESOURCES_ROOT}asset-list/asset-list.js`, 'utf8'));
  // 页面初始加载与取待处理请求都是异步的，等它们完成。
  await new Promise((resolve) => window.setTimeout(resolve, 20));
  return { document, requests, forms };
}

/** 页面里创建的对象与测试不在同一个 JS 环境，比较前先转成普通对象。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 按可访问名称或文字找按钮。 */
function findButton(root, label) {
  return [...root.querySelectorAll('button')].find((button) => (button.getAttribute('aria-label') ?? button.textContent).includes(label));
}

test('生成来源的行有生成相关按钮，上传来源的行只有修改、删除，没有提示词与版本入口', async () => {
  const { document } = await setup([
    makeAsset({ id: 1, name: '生成的角色' }),
    makeAsset({ id: 2, name: '上传的角色', fileSource: 'upload', fileCount: 1, uploadFileCount: 1 })
  ]);
  const [generatedRow, uploadRow] = [...document.querySelectorAll('tbody tr')];
  for (const label of ['生成图片', '提示词', '查看版本', '改用上传']) {
    assert.ok(findButton(generatedRow, label), `生成来源应有“${label}”`);
  }
  assert.ok(findButton(uploadRow, '改用生成'));
  for (const label of ['生成图片', '提示词', '查看版本', '生成提示词']) {
    assert.equal(findButton(uploadRow, label), undefined, `上传来源不应有“${label}”`);
  }
  assert.ok(findButton(uploadRow, '修改') && findButton(uploadRow, '删除'));
});

test('改用生成：直接发出切换请求；改用上传且已有上传的文件时同样直接切换', async () => {
  const { document, requests } = await setup([
    makeAsset({ id: 2, name: '上传的角色', fileSource: 'upload', fileCount: 1, uploadFileCount: 1 }),
    makeAsset({ id: 3, name: '生成的角色', uploadFileCount: 2 })
  ]);
  const [uploadRow, generatedRow] = [...document.querySelectorAll('tbody tr')];
  fire(env, findButton(uploadRow, '改用生成'), 'click');
  fire(env, findButton(generatedRow, '改用上传'), 'click');
  await new Promise((resolve) => env.window.setTimeout(resolve, 10));
  assert.deepEqual(
    plain(requests.filter(([name]) => name === 'assets.switchSource')),
    [
      ['assets.switchSource', { id: 2, source: 'generated' }],
      ['assets.switchSource', { id: 3, source: 'upload' }]
    ]
  );
});

test('改用上传但还没有上传过文件：打开上传表单，不发切换请求', async () => {
  const { document, requests, forms } = await setup([makeAsset({ id: 5, name: '生成的角色', uploadFileCount: 0 })]);
  fire(env, findButton(document, '改用上传'), 'click');
  await new Promise((resolve) => env.window.setTimeout(resolve, 10));
  assert.deepEqual(plain(forms), [{ form: 'asset.edit', params: { assetId: 5, fileSource: 'upload' } }]);
  assert.equal(requests.some(([name]) => name === 'assets.switchSource'), false);
});

test('新建：先选择添加方式，选上传进入上传表单，选 AI 生成进入生成表单，取消不打开表单', async () => {
  const { document, forms } = await setup([]);
  const choose = async (label) => {
    fire(env, findButton(document, '新建'), 'click');
    await new Promise((resolve) => env.window.setTimeout(resolve, 10));
    fire(env, findButton(document, label), 'click');
    await new Promise((resolve) => env.window.setTimeout(resolve, 10));
  };
  await choose('上传图片');
  await choose('AI 生成');
  await choose('取消');
  assert.deepEqual(plain(forms), [
    { form: 'asset.create', params: { kind: 'character', fileSource: 'upload' } },
    { form: 'asset.create', params: { kind: 'character', fileSource: 'generated' } }
  ]);
});
