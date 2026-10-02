// ------------------------------------------------------------------------
// 名称：model-capability-rules.test.ts
// 说明：模型能力描述规则的自动化测试：入库 JSON 往返、时长校验、各类型能力摘要。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖 VS Code 和数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_DURATION_SECONDS } from '../models/model-capability';
import { FAKE_IMAGE_CAPABILITY, FAKE_VIDEO_CAPABILITY } from '../ports/testing/fake-model-providers';
import { isDurationAllowed, parseCapability, serializeCapability, summarizeCapability } from './model-capability-rules';

test('入库 JSON 使用 snake_case 键，读取后还原为 camelCase', () => {
  const json = serializeCapability({ ...FAKE_VIDEO_CAPABILITY, audioInputMax: { count: 2, maxSeconds: 9 }, duration: { min: 2, max: 30, step: 1, allowAuto: true } });
  const stored = JSON.parse(json) as Record<string, unknown>;
  assert.deepEqual(stored.audio_input_max, { count: 2, max_seconds: 9 });
  assert.deepEqual(stored.duration, { min: 2, max: 30, step: 1, allow_auto: true });
  assert.equal('audioInputMax' in stored, false);

  const restored = parseCapability(json);
  assert.deepEqual(restored, { ...FAKE_VIDEO_CAPABILITY, audioInputMax: { count: 2, maxSeconds: 9 }, duration: { min: 2, max: 30, step: 1, allowAuto: true } });
});

test('读取能力描述：不是 JSON 对象时报错', () => {
  assert.throws(() => parseCapability('[]'), /JSON 对象/);
  assert.throws(() => parseCapability('"text"'), /JSON 对象/);
  assert.throws(() => parseCapability('{'));
});

test('时长校验：范围与步长、可选值、智能时长', () => {
  const range = { min: 2, max: 10, step: 2 };
  assert.equal(isDurationAllowed(range, 2), true);
  assert.equal(isDurationAllowed(range, 6), true);
  assert.equal(isDurationAllowed(range, 3), false, '不在步长上');
  assert.equal(isDurationAllowed(range, 1), false);
  assert.equal(isDurationAllowed(range, 12), false);

  assert.equal(isDurationAllowed({ options: [5, 10] }, 10), true);
  assert.equal(isDurationAllowed({ options: [5, 10] }, 7), false);

  assert.equal(isDurationAllowed({ min: 2, max: 30 }, AUTO_DURATION_SECONDS), false, '未声明支持智能时长');
  assert.equal(isDurationAllowed({ min: 2, max: 30, allowAuto: true }, AUTO_DURATION_SECONDS), true);
});

test('能力摘要：视频', () => {
  assert.deepEqual(summarizeCapability('video', FAKE_VIDEO_CAPABILITY), [
    '画幅：16:9、9:16',
    '分辨率：720P、1080P',
    '时长：2–10 秒',
    '帧率：24',
    '输入：首帧、参考图（最多 3 张）',
    '声音：原生生成（对白、音效）'
  ]);
  const minimal = { ...FAKE_VIDEO_CAPABILITY, firstFrame: false, referenceImagesMax: 0, audioModes: ['none' as const], aspectRatios: [], duration: { max: 8, allowAuto: true } };
  const lines = summarizeCapability('video', minimal);
  assert.ok(lines.includes('时长：最长 8 秒，可由模型自动决定'));
  assert.ok(lines.includes('输入：仅文字'));
  assert.ok(lines.includes('声音：无声'));
  assert.ok(!lines.some((line) => line.startsWith('画幅')), '没有画幅时不产生该行');
});

test('能力摘要：图像与音频', () => {
  assert.deepEqual(summarizeCapability('image', FAKE_IMAGE_CAPABILITY), [
    '画幅：1:1',
    '分辨率：1024*1024',
    '单次最多生成：4 张',
    '参考图：不支持'
  ]);
  assert.deepEqual(
    summarizeCapability('audio', {
      audioKinds: ['voice', 'music'],
      duration: { min: 1, max: 60 },
      languages: ['中文'],
      voices: ['甲', '乙'],
      referenceAudio: true,
      promptLanguages: ['zh'],
      promptMaxLength: 100
    }),
    ['类型：音色参考、配乐', '时长：1–60 秒', '语言：中文', '预置音色：2 个', '参考音频：支持']
  );
});
