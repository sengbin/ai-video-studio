// ------------------------------------------------------------------------
// 名称：shot-group-rules.test.ts
// 说明：镜头分组规则的自动化测试：按时长打包、场次变化处断开、补全新增镜头、重新分组、拆分与合并。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../errors';
import {
  DEFAULT_GROUP_MAX_SECONDS,
  GroupedShot,
  groupMaxSecondsOf,
  mergeLayoutIntoPrevious,
  packShots,
  planGroupLayout,
  planRegroupLayout,
  splitLayoutBefore,
  sumSeconds
} from './shot-group-rules';

/** 按场次和时长生成镜头，标识从 1 开始。 */
function shots(...items: Array<[string, number]>): Array<{ id: number; sceneLabel: string; durationSeconds: number }> {
  return items.map(([sceneLabel, durationSeconds], index) => ({ id: index + 1, sceneLabel, durationSeconds }));
}

test('单组最长时长：取参数中的值，缺失或不合法时用默认值', () => {
  assert.equal(groupMaxSecondsOf({ groupMaxSeconds: 20 }), 20);
  assert.equal(groupMaxSecondsOf({} as { groupMaxSeconds: number }), DEFAULT_GROUP_MAX_SECONDS);
  assert.equal(groupMaxSecondsOf(null), DEFAULT_GROUP_MAX_SECONDS);
  assert.equal(groupMaxSecondsOf({ groupMaxSeconds: 0 }), DEFAULT_GROUP_MAX_SECONDS);
});

test('打包：按顺序装满一组再开下一组，每组总时长不超过上限，刚好等于上限也算放得下', () => {
  const groups = packShots(shots(['a', 5], ['a', 5], ['a', 5], ['a', 4], ['a', 6]), 15);
  assert.deepEqual(groups.map((group) => group.shotIds), [[1, 2, 3], [4, 5]]);
  assert.ok(groups.every((group) => !group.joinsOpenGroup));
  assert.deepEqual(packShots([], 15), []);
});

test('打包：小数累加有误差也不会误判超限', () => {
  const groups = packShots(shots(['a', 0.1], ['a', 0.2], ['a', 0.3], ['a', 0.4]), 1);
  assert.deepEqual(groups.map((group) => group.shotIds), [[1, 2, 3, 4]]);
});

test('打包：单个镜头超过上限时独占一组，不丢失', () => {
  const groups = packShots(shots(['a', 4], ['a', 20], ['a', 4]), 15);
  assert.deepEqual(groups.map((group) => group.shotIds), [[1], [2], [3]]);
});

test('打包：超限时若是在同一场次中间断开，退回到场次变化处，把本场次的镜头放进下一组', () => {
  // 场次 A 共 8 秒，场次 B 有 3 个 4 秒镜头：第 1 组装到 A + B1 = 12 秒，B2 放不下；B1 属于 B，退回后 A 单独成组（8 >= 7.5）。
  const groups = packShots(shots(['A', 4], ['A', 4], ['B', 4], ['B', 4], ['B', 4]), 15);
  assert.deepEqual(groups.map((group) => group.shotIds), [[1, 2], [3, 4, 5]]);
});

test('打包：退回后前面的部分太短（不足上限一半）或下一组放不下时不退回', () => {
  // A 只有 3 秒，不足 7.5 秒，直接在 B 中间断开。
  assert.deepEqual(packShots(shots(['A', 3], ['B', 6], ['B', 6], ['B', 6]), 15).map((group) => group.shotIds), [[1, 2, 3], [4]]);
  // 退回的 B7 加上新镜头 B9 共 16 秒，下一组放不下，按原样断开。
  assert.deepEqual(packShots(shots(['A', 8], ['B', 7], ['B', 9]), 15).map((group) => group.shotIds), [[1, 2], [3]]);
});

test('打包：场次相同时不会因为空场次标签误认为场次变化', () => {
  assert.deepEqual(packShots(shots(['', 8], ['', 8], ['', 8]), 15).map((group) => group.shotIds), [[1], [2], [3]]);
});

test('打包：已有最后一组还有余量时，新增镜头先并入它；放不下的另开新组', () => {
  const groups = packShots(shots(['a', 4], ['a', 4], ['a', 4]), 15, 10, 'a');
  assert.deepEqual(groups, [
    { shotIds: [1], joinsOpenGroup: true },
    { shotIds: [2, 3], joinsOpenGroup: false }
  ]);
  // 一个也放不下时，不产生并入的空组。
  assert.deepEqual(packShots(shots(['a', 6]), 15, 12, 'a'), [{ shotIds: [1], joinsOpenGroup: false }]);
});

test('补全布局：保留已有的组，丢弃空组，把新增镜头补在最后', () => {
  const current: GroupedShot[] = [
    { id: 1, sceneLabel: 'a', durationSeconds: 5, groupId: 10 },
    { id: 2, sceneLabel: 'a', durationSeconds: 5, groupId: 10 },
    { id: 3, sceneLabel: 'b', durationSeconds: 6, groupId: 11 },
    { id: 4, sceneLabel: 'b', durationSeconds: 4, groupId: null },
    { id: 5, sceneLabel: 'b', durationSeconds: 9, groupId: null }
  ];
  // 组 12 已经没有镜头；组 11 剩 6 秒，4 秒并入，9 秒另开一组。
  assert.deepEqual(planGroupLayout(current, [10, 11, 12], 15), [
    { groupId: 10, shotIds: [1, 2] },
    { groupId: 11, shotIds: [3, 4] },
    { groupId: null, shotIds: [5] }
  ]);
});

test('补全布局：全部没有分组时等同于重新打包；已经完整时布局不变', () => {
  const fresh = shots(['a', 8], ['a', 8], ['a', 8]).map((shot) => ({ ...shot, groupId: null }));
  assert.deepEqual(planGroupLayout(fresh, [], 15), [
    { groupId: null, shotIds: [1] },
    { groupId: null, shotIds: [2] },
    { groupId: null, shotIds: [3] }
  ]);
  const complete = [
    { id: 1, sceneLabel: 'a', durationSeconds: 5, groupId: 1 },
    { id: 2, sceneLabel: 'a', durationSeconds: 5, groupId: 2 }
  ];
  assert.deepEqual(planGroupLayout(complete, [1, 2], 15), [
    { groupId: 1, shotIds: [1] },
    { groupId: 2, shotIds: [2] }
  ]);
});

test('补全布局：指向已不存在的组的镜头按未分组处理', () => {
  const orphan = [{ id: 1, sceneLabel: 'a', durationSeconds: 5, groupId: 99 }];
  assert.deepEqual(planGroupLayout(orphan, [], 15), [{ groupId: null, shotIds: [1] }]);
});

test('重新分组：不保留任何已有的组', () => {
  assert.deepEqual(planRegroupLayout(shots(['a', 8], ['a', 8]), 10), [
    { groupId: null, shotIds: [1] },
    { groupId: null, shotIds: [2] }
  ]);
});

test('拆分：在镜头之前拆开，前半保留原组，后半新建；组内第一个镜头不能拆', () => {
  const layout = [
    { groupId: 1, shotIds: [1, 2, 3] },
    { groupId: 2, shotIds: [4] }
  ];
  assert.deepEqual(splitLayoutBefore(layout, 2), [
    { groupId: 1, shotIds: [1] },
    { groupId: null, shotIds: [2, 3] },
    { groupId: 2, shotIds: [4] }
  ]);
  assert.throws(() => splitLayoutBefore(layout, 1), ValidationError);
  assert.throws(() => splitLayoutBefore(layout, 4), ValidationError);
  assert.throws(() => splitLayoutBefore(layout, 99), ValidationError);
});

test('合并：并入上一组，被并入的组消失；第一组与不存在的组不能合并', () => {
  const layout = [
    { groupId: 1, shotIds: [1] },
    { groupId: 2, shotIds: [2, 3] },
    { groupId: 3, shotIds: [4] }
  ];
  assert.deepEqual(mergeLayoutIntoPrevious(layout, 2), [
    { groupId: 1, shotIds: [1, 2, 3] },
    { groupId: 3, shotIds: [4] }
  ]);
  assert.throws(() => mergeLayoutIntoPrevious(layout, 1), ValidationError);
  assert.throws(() => mergeLayoutIntoPrevious(layout, 99), ValidationError);
});

test('总时长：保留 1 位小数', () => {
  assert.equal(sumSeconds([{ durationSeconds: 0.1 }, { durationSeconds: 0.2 }]), 0.3);
  assert.equal(sumSeconds([]), 0);
});
