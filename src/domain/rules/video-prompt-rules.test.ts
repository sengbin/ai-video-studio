// ------------------------------------------------------------------------
// 名称：video-prompt-rules.test.ts
// 说明：视频提示词编译用到的文字规则的测试：负向清单整理、句子收尾、镜头语言与转场写法、画幅比例解析与比较。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：无
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aspectDiffers, describeCamera, describeImageRatio, describeTransition, endSentence, normalizeNegativeItems, parseAspectRatio } from './video-prompt-rules';

test('负向清单整理：按各种分隔符拆开，去掉空项、重复项和末尾句号，去掉在正向提示词里原样出现的项', () => {
  assert.deepEqual(normalizeNegativeItems('不要字幕，不要水印、不要字幕；不要低清晰度。\n', ''), ['不要字幕', '不要水印', '不要低清晰度']);
  assert.deepEqual(normalizeNegativeItems('  ,，; ', ''), []);
  assert.deepEqual(normalizeNegativeItems('不要字幕，不要水印', '画面里不要字幕出现'), ['不要水印']);
});

test('句子收尾：已有句末标点不重复，英文结尾补“.”，其他补“。”，空串保持为空', () => {
  assert.equal(endSentence('  守夜人登上灯塔 '), '守夜人登上灯塔。');
  assert.equal(endSentence('守夜人登上灯塔。'), '守夜人登上灯塔。');
  assert.equal(endSentence('他问：“谁？”'), '他问：“谁？”。');
  assert.equal(endSentence('A watchman climbs'), 'A watchman climbs.');
  assert.equal(endSentence('Wait!'), 'Wait!');
  assert.equal(endSentence('   '), '');
});

test('镜头语言：景别、机位与视角、摄影机运动按顺序用逗号连接，空字段跳过', () => {
  assert.equal(describeCamera({ shotSize: '中景', cameraAngle: '平视', cameraMovement: '推近' }), '中景，平视，推近');
  assert.equal(describeCamera({ shotSize: ' 特写 ', cameraAngle: '', cameraMovement: '  ' }), '特写');
  assert.equal(describeCamera({ shotSize: '', cameraAngle: '', cameraMovement: '' }), '');
});

test('转场：默认的切不写，其他转场补上“转场”二字', () => {
  for (const normal of ['', ' ', '切', '硬切', '硬切转场', '无']) assert.equal(describeTransition(normal), '', normal);
  assert.equal(describeTransition('叠化'), '叠化转场');
  assert.equal(describeTransition('叠化转场'), '叠化转场');
});

test('画幅比例：解析“宽:高”，格式不对为 null；图片比例与画幅相差超过 8% 才算不一致，任何一方未知视为一致', () => {
  assert.equal(parseAspectRatio('16:9'), 16 / 9);
  assert.equal(parseAspectRatio(' 3:4 '), 0.75);
  for (const bad of [null, '', '16-9', '0:9', 'adaptive']) assert.equal(parseAspectRatio(bad), null, String(bad));
  assert.equal(aspectDiffers(1920, 1080, '16:9'), false);
  assert.equal(aspectDiffers(1800, 1000, '16:9'), false, '1.8 与 1.78 差不到 8%');
  assert.equal(aspectDiffers(750, 1000, '16:9'), true);
  assert.equal(aspectDiffers(1000, 1000, '16:9'), true);
  assert.equal(aspectDiffers(null, 1000, '16:9'), false);
  assert.equal(aspectDiffers(1000, 1000, null), false);
  assert.equal(aspectDiffers(0, 1000, '16:9'), false);
});

test('图片比例说明：接近常见比例时写成“宽:高”，否则写成像素宽高', () => {
  assert.equal(describeImageRatio(750, 1000), '3:4');
  assert.equal(describeImageRatio(1920, 1080), '16:9');
  assert.equal(describeImageRatio(1000, 1000), '1:1');
  assert.equal(describeImageRatio(1234, 777), '1234×777');
});
