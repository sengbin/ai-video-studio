// ------------------------------------------------------------------------
// 名称：storyboard-rules.test.ts
// 说明：分镜脚本规则的自动化测试：生成参数校验、模型输出的镜头与声音校验（实体按名称映射）、用户编辑镜头的校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedOutputError, ValidationError } from '../errors';
import { StoryboardEntity, StoryboardParams } from '../models/storyboard';
import { normalizeShotEdit, normalizeStoryboardParams, parseStoryboard } from './storyboard-rules';

const ENTITIES: StoryboardEntity[] = [
  { id: 1, kind: 'character', name: '守夜人', aliases: ['老陈'] },
  { id: 2, kind: 'scene', name: '灯塔', aliases: [] },
  { id: 3, kind: 'prop', name: '灯塔', aliases: [] }
];

const PARAMS: StoryboardParams = {
  visualStyle: null,
  minShotSeconds: null,
  maxShotSeconds: null,
  groupMaxSeconds: 15,
  maxShots: null,
  continuity: 'ai',
  audioMode: 'native',
  audioElements: ['dialogue', 'narration', 'sfx', 'music'],
  extra: null
};

/** 一个合规的镜头，可按需覆盖字段。 */
function shot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: '守夜人点亮灯塔',
    durationSeconds: 4,
    entities: [{ kind: 'character', name: '守夜人' }],
    promptZh: '灯塔',
    promptEn: 'lighthouse',
    firstFrameMode: 'none',
    sounds: [],
    ...overrides
  };
}

/** 捕获输出校验的问题列表。 */
function issuesOf(raw: unknown, params: StoryboardParams = PARAMS): readonly string[] {
  try {
    parseStoryboard(raw, { params, entities: ENTITIES });
  } catch (error) {
    if (error instanceof GeneratedOutputError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

test('参数：空输入取默认值（由 AI 判断、模型原生声音、全选声音内容）', () => {
  assert.deepEqual(normalizeStoryboardParams({}), {
    visualStyle: null,
    minShotSeconds: null,
    maxShotSeconds: null,
    groupMaxSeconds: 15,
    maxShots: null,
    continuity: 'ai',
    audioMode: 'native',
    audioElements: ['dialogue', 'narration', 'sfx', 'music'],
    extra: null
  });
});

test('参数：接受界面文字与表单提交的 JSON 数组，数字可为文本，无声时清空声音内容', () => {
  const params = normalizeStoryboardParams({
    visualStyle: ' 水彩 ',
    minShotSeconds: '2.5',
    maxShotSeconds: 8,
    groupMaxSeconds: '20',
    maxShots: '30',
    continuity: '尾帧接首帧',
    audioMode: '模型原生生成',
    audioElements: JSON.stringify(['背景音乐', '角色对白']),
    extra: '少用特写'
  });
  assert.deepEqual(params, {
    visualStyle: '水彩',
    minShotSeconds: 2.5,
    maxShotSeconds: 8,
    groupMaxSeconds: 20,
    maxShots: 30,
    continuity: 'prev_tail',
    audioMode: 'native',
    audioElements: ['dialogue', 'music'],
    extra: '少用特写'
  });
  assert.deepEqual(normalizeStoryboardParams({ audioMode: '无声', audioElements: '[]' }).audioElements, []);
});

test('参数：不合法的字段一并报错', () => {
  assert.throws(
    () =>
      normalizeStoryboardParams({
        minShotSeconds: '8',
        maxShotSeconds: '3',
        maxShots: '0',
        continuity: '随便',
        audioElements: '[]'
      }),
    (error) =>
      error instanceof ValidationError &&
      error.fieldErrors.maxShotSeconds !== undefined &&
      error.fieldErrors.maxShots !== undefined &&
      error.fieldErrors.continuity !== undefined &&
      error.fieldErrors.audioElements !== undefined
  );
  assert.throws(() => normalizeStoryboardParams({ minShotSeconds: '1.25' }), ValidationError);
  assert.throws(() => normalizeStoryboardParams({ audioElements: '["口哨"]' }), ValidationError);
});

test('参数：单组最长时长为整数且在范围内，单镜头时长不能超过它', () => {
  assert.equal(normalizeStoryboardParams({ groupMaxSeconds: '30' }).groupMaxSeconds, 30);
  for (const groupMaxSeconds of ['1', '121', '12.5', 'x']) {
    assert.throws(() => normalizeStoryboardParams({ groupMaxSeconds }), (error) => error instanceof ValidationError && error.fieldErrors.groupMaxSeconds !== undefined, groupMaxSeconds);
  }
  assert.throws(
    () => normalizeStoryboardParams({ groupMaxSeconds: '10', maxShotSeconds: '12' }),
    (error) => error instanceof ValidationError && /不能大于单组最长时长/.test(error.fieldErrors.maxShotSeconds ?? '')
  );
  assert.throws(() => normalizeStoryboardParams({ groupMaxSeconds: '10', minShotSeconds: '11' }), (error) => error instanceof ValidationError && error.fieldErrors.minShotSeconds !== undefined);
});

test('解析：镜头时长不能超过单组最长时长，否则放不进任何一组', () => {
  const params = { ...PARAMS, groupMaxSeconds: 10 };
  assert.deepEqual(issuesOf({ shots: [shot({ durationSeconds: 11 })] }, params), ['第 1 个镜头的 durationSeconds 必须是 0.1 到 10 之间的数字。']);
  assert.deepEqual(issuesOf({ shots: [shot({ durationSeconds: 10 })] }, params), []);
});

test('解析：所有镜头总时长不能超过本集目标时长，恰好等于或没有目标时长时通过', () => {
  const raw = { shots: [shot(), shot(), shot(), shot()] };
  const issues = (maxTotalSeconds: number | null): readonly string[] => {
    try {
      parseStoryboard(raw, { params: PARAMS, entities: ENTITIES, maxTotalSeconds });
    } catch (error) {
      if (error instanceof GeneratedOutputError) {
        return error.issues;
      }
      throw error;
    }
    return [];
  };
  assert.deepEqual(issues(15), ['所有镜头总时长 16 秒，超过本集目标时长 15 秒，请减少镜头或缩短镜头时长。']);
  assert.deepEqual(issues(16), []);
  assert.deepEqual(issues(null), []);
});

test('解析：镜头序号由顺序决定，实体按（类型，名称或别名）映射为标识，说话人自动加入出场实体', () => {
  const shots = parseStoryboard(
    {
      shots: [
        shot({ entities: [{ kind: 'scene', name: '灯塔' }, { kind: 'prop', name: '灯塔' }] }),
        shot({
          firstFrameMode: 'prev_tail',
          entities: [],
          sounds: [
            { kind: 'dialogue', speaker: '老陈', text: '今晚会下雨。', delivery: '低声' },
            { kind: 'sfx', text: '雷声', durationSeconds: 2 }
          ]
        })
      ]
    },
    { params: PARAMS, entities: ENTITIES }
  );
  assert.deepEqual(shots.map((item) => item.seq), [1, 2]);
  assert.deepEqual(shots[0].entityIds, [2, 3], '同名不同类型的实体分别映射');
  assert.equal(shots[1].firstFrameMode, 'prev_tail');
  assert.deepEqual(shots[1].entityIds, [1], '老陈是守夜人的别名，并加入出场实体');
  assert.equal(shots[1].sounds[0].speakerEntityId, 1);
  assert.equal(shots[1].sounds[1].durationSeconds, 2);
});

test('解析：连贯策略决定首帧来源，不依赖模型', () => {
  const none = parseStoryboard({ shots: [shot(), shot({ firstFrameMode: 'prev_tail' })] }, { params: { ...PARAMS, continuity: 'none' }, entities: ENTITIES });
  assert.deepEqual(none.map((item) => item.firstFrameMode), ['none', 'none']);
  const chain = parseStoryboard({ shots: [shot(), shot(), shot()] }, { params: { ...PARAMS, continuity: 'prev_tail' }, entities: ENTITIES });
  assert.deepEqual(chain.map((item) => item.firstFrameMode), ['none', 'prev_tail', 'prev_tail']);
  assert.match(issuesOf({ shots: [shot({ firstFrameMode: 'prev_tail' })] }).join(), /第 1 个镜头.*prev_tail/);
});

test('解析：无声时忽略声音条目；声音类型必须在参数启用的范围内', () => {
  const silent = parseStoryboard(
    { shots: [shot({ sounds: [{ kind: 'music', text: '配乐' }] })] },
    { params: { ...PARAMS, audioMode: 'none', audioElements: [] }, entities: ENTITIES }
  );
  assert.deepEqual(silent[0].sounds, []);
  const limited = { ...PARAMS, audioElements: ['sfx' as const] };
  assert.match(issuesOf({ shots: [shot({ sounds: [{ kind: 'music', text: '配乐' }] })] }, limited).join(), /kind 必须是以下之一：sfx/);
});

test('解析：引用不存在的实体、说话人不是角色、缺字段、时长越界都会报出具体问题', () => {
  const issues = issuesOf({
    shots: [
      shot({ entities: [{ kind: 'character', name: '路人' }], durationSeconds: 0 }),
      shot({ action: '', promptZh: '', sounds: [{ kind: 'dialogue', speaker: '灯塔', text: '你好' }] })
    ]
  }).join('\n');
  assert.match(issues, /第 1 个镜头引用了不存在的角色“路人”/);
  assert.match(issues, /第 1 个镜头的 durationSeconds/);
  assert.match(issues, /第 2 个镜头的 action 不能为空/);
  assert.match(issues, /第 2 个镜头的 promptZh 不能为空/);
  assert.match(issues, /speaker 必须是剧本中已有的角色名称/);
});

test('解析：镜头数与时长受参数限制', () => {
  const limited = { ...PARAMS, maxShots: 1, minShotSeconds: 3, maxShotSeconds: 5 };
  assert.match(issuesOf({ shots: [shot(), shot()] }, limited).join(), /超过上限 1 个/);
  assert.match(issuesOf({ shots: [shot({ durationSeconds: 8 })] }, limited).join(), /3 到 5 之间/);
  assert.match(issuesOf({ shots: [] }).join(), /至少需要 1 个镜头/);
  assert.match(issuesOf({}).join(), /shots 数组/);
});

test('编辑：规范化镜头字段、出场实体与声音；对白必须选择角色', () => {
  const edit = normalizeShotEdit(
    {
      action: ' 新动作 ',
      durationSeconds: '3.5',
      firstFrameMode: 'prev_tail',
      entityIds: [2],
      sounds: [
        { kind: 'dialogue', speakerEntityId: 1, text: '台词', isEnabled: false },
        { kind: 'music', text: '配乐', startOffsetSeconds: '', durationSeconds: 3 }
      ]
    },
    ENTITIES,
    false
  );
  assert.equal(edit.action, '新动作');
  assert.equal(edit.durationSeconds, 3.5);
  assert.deepEqual(edit.entityIds, [2, 1], '说话人自动加入出场实体');
  assert.deepEqual(edit.sounds.map((sound) => [sound.kind, sound.speakerEntityId, sound.isEnabled]), [['dialogue', 1, false], ['music', null, true]]);

  assert.throws(
    () => normalizeShotEdit({ action: '', durationSeconds: '', firstFrameMode: 'prev_tail', entityIds: [99], sounds: [{ kind: 'dialogue', text: '' }] }, ENTITIES, true),
    (error) =>
      error instanceof ValidationError &&
      error.fieldErrors.action !== undefined &&
      error.fieldErrors.durationSeconds !== undefined &&
      error.fieldErrors.firstFrameMode !== undefined &&
      error.fieldErrors.entityIds !== undefined &&
      error.fieldErrors.sounds !== undefined
  );
});
