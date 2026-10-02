// ------------------------------------------------------------------------
// 名称：asset-generation-rules.test.ts
// 说明：资产生成规则的自动化测试：修订号的计算、参考文件的比较、“需更新”“有改动未生成”的推算与能否生成的判断。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AssetContent, AssetFileRecord, AssetGenerationSummary, AssetRecord, NewAssetFile } from '../models/asset';
import {
  checkGenerationAvailability,
  computeRevisionUpdate,
  contentFieldsChanged,
  hasUngeneratedChanges,
  isPromptOutdated,
  modelKindOfAsset,
  sameReferenceFiles
} from './asset-generation-rules';

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 1, projectId: 1, kind: 'character', name: '林夏', sourceEntityId: null, attributes: { appearance: '短发' }, composition: '半身像', style: null,
    background: '', referenceAspectRatio: '1:1', extraRequirements: '', promptZh: '提示', promptEn: 'prompt', contentRevision: 2, promptRevision: 3,
    promptContentRevision: 2, promptStatus: 'succeeded', promptError: null, adoptedVersionId: null, createdAt: 't', updatedAt: 't', ...overrides
  };
}

function content(base: AssetRecord, overrides: Partial<AssetContent> = {}): AssetContent {
  return {
    name: base.name, attributes: base.attributes, composition: base.composition, style: base.style, background: base.background,
    referenceAspectRatio: base.referenceAspectRatio, extraRequirements: base.extraRequirements, promptZh: base.promptZh, promptEn: base.promptEn, ...overrides
  };
}

const EMPTY_SUMMARY: AssetGenerationSummary = { versionCount: 0, latest: null, latestSucceeded: null, adoptedVersion: null };

function summary(contentRevision: number, promptRevision: number, status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' = 'succeeded'): AssetGenerationSummary {
  return { versionCount: 1, latest: { id: 1, version: 1, status, contentRevision, promptRevision, errorMessage: null }, latestSucceeded: 1, adoptedVersion: null };
}

test('影响生成的字段：名称、提示词不算；描述、构图、风格、背景、画幅、补充要求算；描述字段键的顺序不影响比较', () => {
  const base = asset({ attributes: { appearance: '短发', clothing: '风衣' } });
  assert.equal(contentFieldsChanged(base, content(base, { name: '改名', promptZh: '改过' })), false);
  assert.equal(contentFieldsChanged(base, content(base, { attributes: { clothing: '风衣', appearance: '短发' } })), false);
  for (const patch of [
    { attributes: { appearance: '长发', clothing: '风衣' } },
    { composition: '全身像' },
    { style: '水彩' },
    { background: '纯色' },
    { referenceAspectRatio: '16:9' },
    { extraRequirements: '微笑' }
  ] satisfies Partial<AssetContent>[]) {
    assert.equal(contentFieldsChanged(base, content(base, patch)), true, JSON.stringify(patch));
  }
});

test('修订号：改表单加内容修订号；改提示词加提示词修订号并视为已确认；同时改以保存后的内容修订号为准；清空提示词没有依据', () => {
  const base = asset();
  assert.deepEqual(computeRevisionUpdate(base, content(base), false), { contentRevision: 2, promptRevision: 3, promptContentRevision: 2, clearAdopted: false });
  assert.deepEqual(computeRevisionUpdate(base, content(base, { composition: '全身像' }), false), { contentRevision: 3, promptRevision: 3, promptContentRevision: 2, clearAdopted: false });
  assert.deepEqual(computeRevisionUpdate(base, content(base, { promptEn: 'new' }), true), { contentRevision: 2, promptRevision: 4, promptContentRevision: 2, clearAdopted: true });
  assert.deepEqual(computeRevisionUpdate(base, content(base, { composition: '全身像', promptZh: '新' }), false), { contentRevision: 3, promptRevision: 4, promptContentRevision: 3, clearAdopted: false });
  assert.deepEqual(computeRevisionUpdate(base, content(base, { promptZh: '', promptEn: '' }), false), { contentRevision: 2, promptRevision: 4, promptContentRevision: 0, clearAdopted: false });
});

test('提示词需更新：有提示词且依据的内容修订号落后；没有提示词不算', () => {
  assert.equal(isPromptOutdated(asset({ promptContentRevision: 1 })), true);
  assert.equal(isPromptOutdated(asset({ promptContentRevision: 2 })), false);
  assert.equal(isPromptOutdated(asset({ promptContentRevision: 0, promptZh: '', promptEn: '' })), false);
});

test('有改动未生成：没有版本不算；最新版本的任一修订号落后才算', () => {
  const current = asset();
  assert.equal(hasUngeneratedChanges(current, EMPTY_SUMMARY), false);
  assert.equal(hasUngeneratedChanges(current, summary(2, 3)), false);
  assert.equal(hasUngeneratedChanges(current, summary(1, 3)), true);
  assert.equal(hasUngeneratedChanges(current, summary(2, 2)), true);
});

test('参考文件比较：数量、顺序、名称与内容都一致才算没改', () => {
  const stored = (name: string, bytes: number[]): AssetFileRecord => ({
    id: 1, assetId: 1, role: 'reference', fileName: name, mime: 'image/png', width: 1, height: 1, durationSeconds: null, content: Buffer.from(bytes), sortOrder: 0
  });
  const incoming = (name: string, bytes: number[], role: NewAssetFile['role'] = 'reference'): NewAssetFile => ({
    role, fileName: name, mime: 'image/png', width: 1, height: 1, durationSeconds: null, content: Buffer.from(bytes), sortOrder: 0
  });
  assert.equal(sameReferenceFiles([], []), true);
  assert.equal(sameReferenceFiles([stored('a.png', [1])], [incoming('a.png', [1]), incoming('t.png', [9], 'thumbnail')]), true, '缩略图不参与比较');
  assert.equal(sameReferenceFiles([stored('a.png', [1])], [incoming('b.png', [1])]), false);
  assert.equal(sameReferenceFiles([stored('a.png', [1])], [incoming('a.png', [2])]), false);
  assert.equal(sameReferenceFiles([stored('a.png', [1])], []), false);
});

test('能否生成：提示词生成中、没有提示词、已有进行中的版本、没有可用模型依次给出原因', () => {
  const ok = checkGenerationAvailability(asset(), EMPTY_SUMMARY, true);
  assert.deepEqual(ok, { available: true, reason: null });
  assert.match(checkGenerationAvailability(asset({ promptStatus: 'running' }), EMPTY_SUMMARY, true).reason ?? '', /提示词生成中/);
  assert.match(checkGenerationAvailability(asset({ promptZh: '', promptEn: '' }), EMPTY_SUMMARY, true).reason ?? '', /先生成或填写提示词/);
  assert.match(checkGenerationAvailability(asset(), summary(2, 3, 'running'), true).reason ?? '', /正在生成/);
  assert.equal(checkGenerationAvailability(asset(), summary(2, 3, 'failed'), true).available, true, '失败的版本不阻止再次生成');
  assert.match(checkGenerationAvailability(asset(), EMPTY_SUMMARY, false).reason ?? '', /启用图像模型/);
  assert.match(checkGenerationAvailability(asset({ kind: 'audio' }), EMPTY_SUMMARY, false).reason ?? '', /启用音频模型/);
});

test('资产类型对应的模型类型：音频用音频模型，其余用图像模型', () => {
  assert.deepEqual((['character', 'scene', 'prop', 'effect', 'audio'] as const).map(modelKindOfAsset), ['image', 'image', 'image', 'image', 'audio']);
});
