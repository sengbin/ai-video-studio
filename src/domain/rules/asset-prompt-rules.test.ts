// ------------------------------------------------------------------------
// 名称：asset-prompt-rules.test.ts
// 说明：资产提示词规则的自动化测试：草稿整理与提示词校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedOutputError } from '../errors';
import { describeAssetDraft, isPromptAssetKind, parseAssetPrompts } from './asset-prompt-rules';

test('整理草稿：名称在前，空字段不列出，项目风格只在资产没有风格时沿用', () => {
  const draft = describeAssetDraft('character', { name: ' 林夏 ', appearance: '短发', clothing: '  ', composition: '半身像' }, '写实摄影');
  assert.equal(draft.name, '林夏');
  assert.deepEqual(draft.lines, ['角色名称：林夏', '视角与构图：半身像', '画面风格（沿用项目风格）：写实摄影', '角色外观：短发']);
  assert.equal(draft.detailCount, 2, '项目风格不算用户填写的字段');

  const own = describeAssetDraft('prop', { name: '钥匙', style: '水彩', state: '生锈' }, '写实摄影');
  assert.deepEqual(own.lines, ['道具名称：钥匙', '画面风格：水彩', '当前状态：生锈']);
  assert.equal(own.detailCount, 2);

  const empty = describeAssetDraft('scene', { appearance: 5 }, null);
  assert.deepEqual([empty.name, empty.lines, empty.detailCount], ['', [], 0]);
});

test('只有图像类资产支持生成提示词', () => {
  assert.deepEqual((['character', 'scene', 'prop', 'effect', 'audio'] as const).map(isPromptAssetKind), [true, true, true, true, false]);
});

test('校验提示词：去除首尾空白；缺失、为空、过长时抛出输出错误', () => {
  assert.deepEqual(parseAssetPrompts({ promptZh: ' 中文 ', promptEn: ' english ' }), { promptZh: '中文', promptEn: 'english' });

  const issuesOf = (raw: unknown): readonly string[] => {
    try {
      parseAssetPrompts(raw);
    } catch (error) {
      if (error instanceof GeneratedOutputError) {
        return error.issues;
      }
    }
    return [];
  };
  assert.equal(issuesOf(null).length, 1);
  assert.deepEqual(issuesOf({ promptZh: '', promptEn: 5 }), ['中文提示词不能为空。', '英文提示词不能为空。']);
  assert.match(issuesOf({ promptZh: 'x'.repeat(2001), promptEn: 'ok' })[0], /超过上限 2000 字/);
});
