// ------------------------------------------------------------------------
// 名称：text-generation-settings.test.ts
// 说明：文本生成设置规范化的自动化测试：默认值、非法值回退、字数上限夹取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SEGMENT_CHARS,
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  normalizeTextGenerationSettings
} from './text-generation-settings';

test('缺少设置时使用默认值：使用 Copilot、自动选择模型、按章节分段、每段 20000 字', () => {
  assert.deepEqual(normalizeTextGenerationSettings({}), {
    copilotEnabled: true,
    modelFamily: '',
    novelSplit: { mode: 'chapter', maxSegmentChars: DEFAULT_SEGMENT_CHARS }
  });
});

test('合法设置原样使用，模型家族去除首尾空白', () => {
  assert.deepEqual(normalizeTextGenerationSettings({ copilotEnabled: false, modelFamily: ' gpt-4o ', splitMode: 'length', maxSegmentChars: 30000 }), {
    copilotEnabled: false,
    modelFamily: 'gpt-4o',
    novelSplit: { mode: 'length', maxSegmentChars: 30000 }
  });
});

test('非法设置回退为默认值', () => {
  const settings = normalizeTextGenerationSettings({ copilotEnabled: 'no', modelFamily: 5, splitMode: 'paragraph', maxSegmentChars: '20000' });
  assert.equal(settings.copilotEnabled, true);
  assert.equal(settings.modelFamily, '');
  assert.equal(settings.novelSplit.mode, 'chapter');
  assert.equal(settings.novelSplit.maxSegmentChars, DEFAULT_SEGMENT_CHARS);
  assert.equal(normalizeTextGenerationSettings({ maxSegmentChars: Number.NaN }).novelSplit.maxSegmentChars, DEFAULT_SEGMENT_CHARS);
});

test('每段字数上限夹到允许范围内并取整', () => {
  assert.equal(normalizeTextGenerationSettings({ maxSegmentChars: 100 }).novelSplit.maxSegmentChars, SEGMENT_CHARS_MIN);
  assert.equal(normalizeTextGenerationSettings({ maxSegmentChars: 10_000_000 }).novelSplit.maxSegmentChars, SEGMENT_CHARS_MAX);
  assert.equal(normalizeTextGenerationSettings({ maxSegmentChars: 5000.9 }).novelSplit.maxSegmentChars, 5000);
});
