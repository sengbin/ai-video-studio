// ------------------------------------------------------------------------
// 名称：entity-asset-prefill.test.ts
// 说明：从实体设定预填资产表单的规则测试：字段对应、补充要求与长度截断。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BindingEntityDetail } from '../models/binding';
import { buildAssetPrefill } from './entity-asset-prefill';

function entity(kind: BindingEntityDetail['kind'], attributes: Record<string, string>, description = '', name = '实体'): BindingEntityDetail {
  return { projectId: 1, kind, name, description, attributes };
}

test('角色：外观、服装、音色对应到描述字段，其余设定与概述并入补充要求', () => {
  const values = buildAssetPrefill(
    entity('character', { appearance: '花白胡须', outfit: '雨衣', voice: '沙哑', identity: '守塔人', relations: '' }, '灯塔守护者', '守夜人')
  );
  assert.deepEqual(values, {
    name: '守夜人',
    appearance: '花白胡须',
    clothing: '雨衣',
    voiceDescription: '沙哑',
    extra: '设定概述：灯塔守护者\n身份与目标：守塔人'
  });
});

test('场景、道具、特效：各自的对应关系，没有内容的字段不出现', () => {
  assert.deepEqual(buildAssetPrefill(entity('scene', { interior_exterior: '内景', layout: '一间圆形大厅', fixtures: '旧书架', time_light: '黄昏' })), {
    name: '实体',
    placeType: '内景',
    layout: '一间圆形大厅',
    environment: '黄昏',
    extra: '固定陈设：旧书架'
  });
  assert.deepEqual(buildAssetPrefill(entity('prop', { appearance: '黄铜钥匙', states: '生锈', usage: '开门' })), {
    name: '实体',
    appearance: '黄铜钥匙',
    state: '生锈',
    extra: '用途：开门'
  });
  assert.deepEqual(buildAssetPrefill(entity('effect', { trigger: '魔法阵', appearance: '蓝色光雾', changes: '逐渐扩散', targets: '地面' })), {
    name: '实体',
    source: '魔法阵',
    appearance: '蓝色光雾',
    motion: '逐渐扩散',
    environmentInteraction: '地面'
  });
  assert.deepEqual(buildAssetPrefill(entity('prop', {})), { name: '实体' });
});

test('超过字段长度上限的内容被截断', () => {
  const values = buildAssetPrefill(entity('character', { appearance: '长'.repeat(600), identity: '长'.repeat(1200) }, '', '名'.repeat(80)));
  assert.equal(values.name.length, 50);
  assert.equal(values.appearance.length, 500);
  assert.equal(values.extra.length, 1000);
});
