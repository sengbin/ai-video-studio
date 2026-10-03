// ------------------------------------------------------------------------
// 名称：stage-first-frame.test.mjs
// 说明：分镜脚本产出层“首帧来源”的 DOM 测试：选“指定图片”才出现首帧图片下拉，保存时带上资产标识；已保存的指定图片会回显；其他来源不带资产。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom 加载组件库与 resources/stage 下的脚本，宿主请求用假的 hostBridge 应答并记录保存请求；放在 ui-kit/test 是因为 npm test 只收集这里的页面测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createUiEnvironment } from './ui-environment.mjs';

const RESOURCES_ROOT = fileURLToPath(new URL('../../resources/', import.meta.url));
const WORK_ID = 1;
const EPISODE_ID = 7;
const FIRST_SHOT_ID = 101;
const SCENE_ASSET_ID = 5;

let env;

afterEach(() => env?.close());

/** 构造一个镜头；字段与宿主返回的镜头一致。 */
function makeShot(seq, overrides = {}) {
  return {
    id: FIRST_SHOT_ID + seq - 1,
    seq,
    sceneLabel: '',
    shotSize: '中景',
    cameraAngle: '',
    action: `镜头${seq}的画面`,
    cameraMovement: '',
    durationSeconds: 3,
    transition: '',
    continuityNote: '',
    firstFrameMode: 'none',
    firstFrameAssetId: null,
    entityIds: [],
    sounds: [],
    promptZh: '',
    promptEn: '',
    ...overrides
  };
}

/** 宿主返回的分镜脚本阶段视图：两个镜头，资产库里有一个带参考图的场景资产。 */
function makeView(shots) {
  return {
    work: { id: WORK_ID, projectId: 1, name: '作品甲', kind: 'series', sourceType: 'text' },
    episode: { id: EPISODE_ID, seq: 1, title: '第一集' },
    versions: [{ id: 1, version: 1, display: 'pending', isCurrent: true }],
    run: { id: 1, display: 'pending', createdAt: new Date().toISOString(), hasRawOutput: false, modelInfo: '', progress: null },
    params: null,
    shots,
    groups: [{ id: 1, seq: 1, shotIds: shots.map((shot) => shot.id), totalSeconds: 6 }],
    groupMaxSeconds: 12,
    totalSeconds: 6,
    entities: [],
    firstFrameAssets: [{ id: SCENE_ASSET_ID, kindLabel: '场景', name: '灯塔远景' }],
    soundKinds: [{ kind: 'dialogue', label: '对白' }],
    stale: false,
    actions: { canEdit: true, canApprove: true, canCancel: false, canRetry: false, editNeedsConfirm: false }
  };
}

/** 建立测试页面并打开产出层，返回页面与记录到的保存请求。 */
async function open(shots) {
  env = createUiEnvironment();
  const { window } = env;
  const saved = [];
  window.hostBridge = {
    request: async (name, payload) => {
      if (name === 'stage.saveShot') {
        saved.push(payload);
        return { ref: payload.ref };
      }
      assert.equal(name, 'stage.load');
      return makeView(shots);
    },
    onEvent: () => undefined
  };
  for (const file of ['shared/page-format.js', 'stage/stage.js', 'stage/stage-storyboard.js']) {
    window.eval(readFileSync(`${RESOURCES_ROOT}${file}`, 'utf8'));
  }
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID, shots[0].id);
  await flush();
  return { window, doc: env.document, saved };
}

/** 等待已排队的异步任务（含请求应答）执行完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 在页面里点开某个下拉并选中显示为 label 的选项。 */
function choose(doc, ariaLabel, label) {
  doc.querySelector(`[aria-label="${ariaLabel}"]`).click();
  const option = [...doc.querySelectorAll('.ui-select__option')].find((item) => item.textContent.trim() === label);
  assert.ok(option, `下拉“${ariaLabel}”里应有选项“${label}”`);
  option.click();
}

/** 首帧图片字段（外壳）；用于检查是否显示。 */
function assetField(doc) {
  return doc.querySelector('[aria-label="首帧图片"]').closest('.ui-field');
}

test('首帧来源：选“指定图片”才出现首帧图片下拉，保存时带上所选资产', async () => {
  const { doc, saved } = await open([makeShot(1), makeShot(2)]);
  assert.equal(assetField(doc).hidden, true, '默认不指定首帧时不显示首帧图片');

  choose(doc, '首帧来源', '指定图片');
  assert.equal(assetField(doc).hidden, false);
  choose(doc, '首帧图片', '[场景] 灯塔远景');

  [...doc.querySelectorAll('.stage-editor__actions button')].find((button) => button.textContent.trim() === '保存').click();
  await flush();
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].ref, saved[0].firstFrameMode, saved[0].firstFrameAssetId], [FIRST_SHOT_ID, 'asset', SCENE_ASSET_ID]);

  choose(doc, '首帧来源', '不指定');
  assert.equal(assetField(doc).hidden, true, '改回其他来源后隐藏首帧图片');
});

test('首帧来源：已保存的指定图片回显；资产已被删除时选中“指定图片”但没有选定的资产；第 1 个镜头没有“上一镜头尾帧”', async () => {
  const withAsset = await open([makeShot(1, { firstFrameMode: 'asset', firstFrameAssetId: SCENE_ASSET_ID }), makeShot(2)]);
  assert.equal(withAsset.doc.querySelector('[aria-label="首帧来源"]').textContent.trim(), '指定图片');
  assert.equal(withAsset.doc.querySelector('[aria-label="首帧图片"]').textContent.trim(), '[场景] 灯塔远景');
  assert.equal(assetField(withAsset.doc).hidden, false);
  withAsset.doc.querySelector('[aria-label="首帧来源"]').click();
  const labels = [...withAsset.doc.querySelectorAll('.ui-select__option')].map((item) => item.textContent.trim());
  assert.deepEqual(labels, ['不指定', '指定图片']);
  env.close();

  const deleted = await open([makeShot(1, { firstFrameMode: 'asset', firstFrameAssetId: null }), makeShot(2)]);
  assert.equal(deleted.doc.querySelector('[aria-label="首帧来源"]').textContent.trim(), '指定图片');
  assert.notEqual(deleted.doc.querySelector('[aria-label="首帧图片"]').textContent.trim(), '[场景] 灯塔远景');
});
