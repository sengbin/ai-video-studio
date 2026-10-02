// ------------------------------------------------------------------------
// 名称：stage-focus.test.mjs
// 说明：分镜脚本产出层“定位到所选镜头”的 DOM 测试：打开时选中并滚动到指定镜头、已打开时重新定位、镜头不存在时保持默认选中、有未保存修改时询问。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom 加载组件库与 resources/stage 下的脚本，宿主请求用假的 hostBridge 应答；jsdom 没有排版，滚动用 scrollIntoView 的替换实现记录；放在 ui-kit/test 是因为 npm test 只收集这里的页面测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createUiEnvironment } from './ui-environment.mjs';

const RESOURCES_ROOT = fileURLToPath(new URL('../../resources/', import.meta.url));
const SHOT_COUNT = 12;
const WORK_ID = 1;
const EPISODE_ID = 7;
/** 镜头标识从 100 起，与序号区分开。 */
const FIRST_SHOT_ID = 101;

let env;

afterEach(() => env?.close());

/** 构造一个镜头；字段与宿主返回的镜头一致。 */
function makeShot(seq) {
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
    entityIds: [],
    sounds: [],
    promptZh: '',
    promptEn: ''
  };
}

/** 宿主返回的分镜脚本阶段视图：每 4 个镜头一组。 */
function makeView() {
  const shots = Array.from({ length: SHOT_COUNT }, (_, index) => makeShot(index + 1));
  return {
    work: { id: WORK_ID, projectId: 1, name: '作品甲', kind: 'series', sourceType: 'text' },
    episode: { id: EPISODE_ID, seq: 1, title: '第一集' },
    versions: [{ id: 1, version: 1, display: 'approved', isCurrent: true }],
    run: { id: 1, display: 'approved', createdAt: new Date().toISOString(), hasRawOutput: false, modelInfo: '', progress: null },
    params: null,
    shots,
    groups: [0, 1, 2].map((index) => ({ id: index + 1, seq: index + 1, shotIds: shots.slice(index * 4, index * 4 + 4).map((shot) => shot.id), totalSeconds: 12 })),
    groupMaxSeconds: 12,
    totalSeconds: 36,
    entities: [],
    soundKinds: [{ kind: 'dialogue', label: '对白' }],
    stale: false,
    actions: { canEdit: true, canApprove: false, canCancel: false, canRetry: false, editNeedsConfirm: false }
  };
}

/** 建立测试页面：组件库、假的宿主通信桥，以及 stage.js 与 stage-storyboard.js。 */
function setup() {
  env = createUiEnvironment();
  const { window } = env;
  const scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this);
  };
  window.hostBridge = {
    request: async (name) => {
      assert.equal(name, 'stage.load', '本测试只会向宿主请求加载阶段视图');
      return makeView();
    },
    onEvent: () => undefined
  };
  for (const file of ['shared/page-format.js', 'stage/stage.js', 'stage/stage-storyboard.js']) {
    window.eval(readFileSync(`${RESOURCES_ROOT}${file}`, 'utf8'));
  }
  return { window, doc: env.document, scrolled };
}

/** 等待已排队的异步任务（含请求应答）执行完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 当前列表中带“当前”语义标记的镜头标题。 */
function currentItems(doc) {
  return [...doc.querySelectorAll('.stage-item[aria-current="true"]')];
}

test('打开时指定镜头：选中该镜头并带 aria-current，滚动到可见；其他镜头不被选中', async () => {
  const { window, doc, scrolled } = setup();
  const target = FIRST_SHOT_ID + 8;
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID, target);
  await flush();

  const items = currentItems(doc);
  assert.equal(items.length, 1, '只有一个镜头被标记为当前');
  assert.match(items[0].querySelector('.stage-item__title').textContent, /^9\. /);
  assert.ok(items[0].classList.contains('is-selected'), '选中项带 is-selected 样式类（样式含 3px 左标记，不只靠颜色）');
  assert.deepEqual(scrolled, [items[0]], '选中的镜头被滚动到可见');
  assert.equal(doc.querySelectorAll('.stage-item.is-selected').length, 1);
});

test('不指定镜头：默认选中第一个镜头，不触发滚动', async () => {
  const { window, doc, scrolled } = setup();
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID);
  await flush();

  assert.match(currentItems(doc)[0].querySelector('.stage-item__title').textContent, /^1\. /);
  assert.equal(scrolled.length, 0);
});

test('指定的镜头不在当前版本里：回到默认选中第一个镜头', async () => {
  const { window, doc } = setup();
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID, 99999);
  await flush();

  assert.equal(currentItems(doc).length, 1);
  assert.match(currentItems(doc)[0].querySelector('.stage-item__title').textContent, /^1\. /);
});

test('产出层已经打开时再次指定镜头：不重复打开，重新定位到新的镜头', async () => {
  const { window, doc, scrolled } = setup();
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID, FIRST_SHOT_ID + 2);
  await flush();
  window.aiStage.open(WORK_ID, 'storyboard_script', EPISODE_ID, FIRST_SHOT_ID + 10);
  await flush();

  assert.equal(doc.querySelectorAll('.stage-view').length, 1, '同一集只有一个产出层');
  assert.match(currentItems(doc)[0].querySelector('.stage-item__title').textContent, /^11\. /);
  assert.equal(scrolled.length, 2, '两次定位各滚动一次');
});
