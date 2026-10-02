// ------------------------------------------------------------------------
// 名称：storyboard-target-rules.test.ts
// 说明：分镜脚本目标视频模型规则的自动化测试：选项文字、画幅、分辨率与单组最长时长的能力检查。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数测试，不依赖 VS Code 和数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_VIDEO_CAPABILITY } from '../ports/testing/fake-model-providers';
import { capGroupSeconds, checkStoryboardTarget, describeTargetModel } from './storyboard-target-rules';

test('限制单组最长时长：不超过模型上限，没有模型或没有上限信息时原样返回', () => {
  assert.equal(capGroupSeconds(15, FAKE_VIDEO_CAPABILITY), 10);
  assert.equal(capGroupSeconds(8, FAKE_VIDEO_CAPABILITY), 8);
  assert.equal(capGroupSeconds(15, undefined), 15);
  assert.equal(capGroupSeconds(15, { ...FAKE_VIDEO_CAPABILITY, duration: {} }), 15);
});

test('选项文字：服务商与模型名，已知单次最长时长时附带', () => {
  assert.equal(describeTargetModel('假服务商', '假视频模型', FAKE_VIDEO_CAPABILITY), '假服务商 · 假视频模型（单次最长 10 秒）');
  assert.equal(describeTargetModel('假服务商', '假视频模型', { ...FAKE_VIDEO_CAPABILITY, duration: {} }), '假服务商 · 假视频模型');
});

test('检查：满足能力时没有错误，未指定的画幅与分辨率不检查', () => {
  assert.deepEqual(checkStoryboardTarget(FAKE_VIDEO_CAPABILITY, { aspectRatio: '16:9', resolution: '720P', groupMaxSeconds: 10 }), {});
  assert.deepEqual(checkStoryboardTarget(FAKE_VIDEO_CAPABILITY, { aspectRatio: null, resolution: '', groupMaxSeconds: 5 }), {});
});

test('检查：画幅、分辨率不在能力内，单组最长时长超过模型上限', () => {
  const errors = checkStoryboardTarget(FAKE_VIDEO_CAPABILITY, { aspectRatio: '1:1', resolution: '4K', groupMaxSeconds: 15 });
  assert.match(errors.aspectRatio, /不支持画幅 1:1.*16:9、9:16/);
  assert.match(errors.resolution, /不支持分辨率 4K.*720P、1080P/);
  assert.match(errors.groupMaxSeconds, /不能超过.*10 秒/);
});

test('检查：模型没有时长上限信息时不校验单组最长时长', () => {
  const unbounded = { ...FAKE_VIDEO_CAPABILITY, duration: { min: 2 } };
  assert.deepEqual(checkStoryboardTarget(unbounded, { aspectRatio: null, resolution: null, groupMaxSeconds: 120 }), {});
});
