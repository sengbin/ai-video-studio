// ------------------------------------------------------------------------
// 名称：scene-batching.test.ts
// 说明：分镜脚本按场次分批规则的自动化测试：场次切分、不分批的情形、按字数打包、超长场次独占一批。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数测试，不依赖 VS Code 和数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planSceneBatches, splitScenes } from './scene-batching';

const THREE_SCENES = ['前言一行', '第1场 灯塔内｜内景｜夜', '守夜人点亮灯塔。', '## 第二场 海边｜外景｜夜', '浪很大。', '第三场 码头｜外景｜晨', '船靠岸。'].join('\n');

test('切分场次：按“第N场”标题行切分，标题之前的内容并入第一个场次，支持井号与中文数字', () => {
  const scenes = splitScenes(THREE_SCENES);
  assert.deepEqual(scenes.map((scene) => scene.heading), ['第1场 灯塔内｜内景｜夜', '## 第二场 海边｜外景｜夜', '第三场 码头｜外景｜晨']);
  assert.ok(scenes[0].text.startsWith('前言一行\n第1场'));
  assert.equal(scenes.map((scene) => scene.text).join('\n'), THREE_SCENES, '切分后按顺序拼回原文');
  assert.deepEqual(splitScenes('没有标题的正文\n第三天清晨'), [], '“第三天”不是场次标题');
});

test('不分批：正文不超过上限，或没有识别出两个以上场次时只有一批且正文原样保留', () => {
  const short = planSceneBatches(THREE_SCENES, 1000);
  assert.equal(short.length, 1);
  assert.equal(short[0].text, THREE_SCENES);
  assert.equal(short[0].sceneCount, 3);

  const long = '没有场次标题的正文。'.repeat(500);
  const single = planSceneBatches(long, 100);
  assert.equal(single.length, 1);
  assert.equal(single[0].text, long);
  assert.equal(single[0].sceneCount, 0);

  const oneScene = `第一场 灯塔\n${'浪'.repeat(500)}`;
  assert.equal(planSceneBatches(oneScene, 100).length, 1, '只有一个场次时无法按场次切开');
});

test('分批：相邻场次按字数打包，每批不超过上限，记录首尾场次标题', () => {
  const scene = (number: number, size: number) => `第${number}场 地点${number}\n${'浪'.repeat(size)}`;
  const text = [scene(1, 40), scene(2, 40), scene(3, 40), scene(4, 40)].join('\n');
  const batches = planSceneBatches(text, 120);
  assert.deepEqual(batches.map((batch) => batch.sceneCount), [2, 2]);
  assert.deepEqual(batches.map((batch) => [batch.firstHeading, batch.lastHeading]), [
    ['第1场 地点1', '第2场 地点2'],
    ['第3场 地点3', '第4场 地点4']
  ]);
  assert.equal(batches.map((batch) => batch.text).join('\n'), text);
  assert.ok(batches.every((batch) => batch.text.length <= 120));
});

test('分批：超过上限的单个场次独占一批，不在场次中间切开', () => {
  const text = [`第1场 甲\n${'浪'.repeat(10)}`, `第2场 乙\n${'风'.repeat(300)}`, `第3场 丙\n${'雨'.repeat(10)}`].join('\n');
  const batches = planSceneBatches(text, 100);
  assert.deepEqual(batches.map((batch) => batch.sceneCount), [1, 1, 1]);
  assert.ok(batches[1].text.length > 100);
});
