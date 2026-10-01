// ------------------------------------------------------------------------
// 名称：screenplay-rules.test.ts
// 说明：剧本阶段规则的自动化测试：参数校验、剧本包与抽取结果的输出校验、集与实体的编辑校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，不依赖存储与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedOutputError, ValidationError } from '../errors';
import {
  EPISODE_TEXT_MAX_LENGTH,
  ScreenplayContext,
  normalizeEntityEdit,
  normalizeEpisodeEdit,
  normalizeScreenplayParams,
  normalizeScreenplayTextEdit,
  parseScreenplayText,
  parseStructure
} from './screenplay-rules';

const PARAMS = { maxEpisodeDurationSeconds: 60, maxEpisodes: 3, extra: null };
const SERIES: ScreenplayContext = { workKind: 'series', workName: '作品甲', params: PARAMS };
const SINGLE: ScreenplayContext = { workKind: 'single', workName: '作品甲', params: { ...PARAMS, maxEpisodes: 1 } };

/** 捕获校验错误的字段错误记录。 */
function captureFieldErrors(action: () => unknown): Readonly<Record<string, string>> {
  try {
    action();
  } catch (error) {
    if (error instanceof ValidationError) {
      return error.fieldErrors;
    }
    throw error;
  }
  assert.fail('应当抛出校验错误');
}

/** 捕获模型输出错误的问题列表。 */
function captureIssues(action: () => unknown): readonly string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof GeneratedOutputError) {
      return error.issues;
    }
    throw error;
  }
  assert.fail('应当抛出输出错误');
}

const ENTITY = { kind: 'character', name: '守夜人', description: '灯塔守夜人' };

test('生成参数：多集需要集数上限，单个短视频的集数上限固定为 1，数字可以是文本', () => {
  assert.deepEqual(normalizeScreenplayParams({ maxEpisodeDurationSeconds: '60', maxEpisodes: '5', extra: ' 悬疑 ' }, 'series'), {
    maxEpisodeDurationSeconds: 60,
    maxEpisodes: 5,
    extra: '悬疑'
  });
  assert.equal(normalizeScreenplayParams({ maxEpisodeDurationSeconds: 30, maxEpisodes: 9 }, 'single').maxEpisodes, 1);

  const errors = captureFieldErrors(() => normalizeScreenplayParams({ maxEpisodeDurationSeconds: '0' }, 'series'));
  assert.ok(errors.maxEpisodeDurationSeconds && errors.maxEpisodes);
  assert.ok(captureFieldErrors(() => normalizeScreenplayParams({ maxEpisodeDurationSeconds: 3601, maxEpisodes: 1 }, 'series')).maxEpisodeDurationSeconds);
  assert.ok(captureFieldErrors(() => normalizeScreenplayParams({ maxEpisodeDurationSeconds: 60, maxEpisodes: 101 }, 'series')).maxEpisodes);
  assert.ok(captureFieldErrors(() => normalizeScreenplayParams({ maxEpisodeDurationSeconds: 60, extra: 'x'.repeat(2001) }, 'single')).extra);
});

test('剧本包：标题、梗概、正文都必须有；单个短视频的正文不得超过单集上限', () => {
  const ok = { title: ' 雨夜 ', overview: '梗概', fullText: '正文' };
  assert.deepEqual(parseScreenplayText(ok, 'series'), { title: '雨夜', overview: '梗概', fullText: '正文' });
  assert.equal(captureIssues(() => parseScreenplayText({ title: '', overview: '', fullText: '' }, 'series')).length, 3);
  assert.equal(captureIssues(() => parseScreenplayText('x', 'series')).length, 1);

  const long = { ...ok, fullText: '长'.repeat(EPISODE_TEXT_MAX_LENGTH + 1) };
  assert.doesNotThrow(() => parseScreenplayText(long, 'series'));
  assert.match(captureIssues(() => parseScreenplayText(long, 'single'))[0], /单个短视频/);
});

test('抽取结果（多集）：集按顺序编号，实体去除空白、重复别名与空设定，只保留该类型的设定字段', () => {
  const structure = parseStructure(
    {
      episodes: [
        { title: ' 第一集 ', synopsis: '开端', screenplayText: '正文一', targetDurationSeconds: 30 },
        { title: '第二集', synopsis: '转折', screenplayText: '正文二' }
      ],
      entities: [
        { ...ENTITY, aliases: [' 老陈 ', '老陈', '守夜人', ''], attributes: { identity: ' 守灯塔 ', voice: '', interior_exterior: '内景' } },
        { kind: 'scene', name: '守夜人', description: '同名但类型不同' }
      ]
    },
    SERIES,
    '全文'
  );
  assert.deepEqual(
    structure.episodes.map((episode) => [episode.seq, episode.title, episode.targetDurationSeconds]),
    [
      [1, '第一集', 30],
      [2, '第二集', null]
    ]
  );
  assert.deepEqual(structure.entities[0].aliases, ['老陈']);
  assert.deepEqual(structure.entities[0].attributes, { identity: '守灯塔' });
  assert.equal(structure.entities[1].kind, 'scene');
  assert.ok(structure.entities.every((entity) => entity.isActive));
});

test('抽取结果（单个短视频）：只有 1 集，标题取作品名称，正文取剧本包正文', () => {
  const structure = parseStructure({ episodes: [{ synopsis: '梗概', targetDurationSeconds: 45 }], entities: [] }, SINGLE, '全文');
  assert.deepEqual(structure.episodes, [{ seq: 1, title: '作品甲', synopsis: '梗概', screenplayText: '全文', targetDurationSeconds: 45 }]);
  assert.match(captureIssues(() => parseStructure({ episodes: [{ synopsis: 'a' }, { synopsis: 'b' }], entities: [] }, SINGLE, '全文'))[0], /只能有 1 集/);
});

test('抽取结果：集数、时长、实体重名与类型不合法时逐条说明问题', () => {
  const tooMany = captureIssues(() =>
    parseStructure({ episodes: Array.from({ length: 4 }, () => ({ title: 't', synopsis: 's', screenplayText: 'x' })), entities: [] }, SERIES, '')
  );
  assert.ok(tooMany.some((issue) => issue.includes('超过上限')));
  assert.ok(captureIssues(() => parseStructure({ episodes: [], entities: [] }, SERIES, '')).some((issue) => issue.includes('至少需要 1 集')));
  assert.ok(
    captureIssues(() =>
      parseStructure({ episodes: [{ title: 't', synopsis: 's', screenplayText: 'x', targetDurationSeconds: 61 }], entities: [] }, SERIES, '')
    ).some((issue) => issue.includes('targetDurationSeconds'))
  );
  const issues = captureIssues(() =>
    parseStructure(
      {
        episodes: [{ title: 't', synopsis: 's', screenplayText: 'x' }],
        entities: [ENTITY, ENTITY, { kind: 'monster', name: '怪' }, { kind: 'prop', name: '' }]
      },
      SERIES,
      ''
    )
  );
  assert.equal(issues.length, 3);
  assert.equal(captureIssues(() => parseStructure({ episodes: [] }, SERIES, '')).length, 1);
});

test('编辑正文：不能为空', () => {
  assert.equal(normalizeScreenplayTextEdit({ fullText: ' 新正文 ' }), '新正文');
  assert.ok(captureFieldErrors(() => normalizeScreenplayTextEdit({ fullText: '  ' })).fullText);
});

test('编辑集：标题必填，目标时长可空，填写时必须是正整数', () => {
  assert.deepEqual(normalizeEpisodeEdit({ title: ' 新标题 ', synopsis: '', screenplayText: '正文', targetDurationSeconds: '' }), {
    title: '新标题',
    synopsis: '',
    screenplayText: '正文',
    targetDurationSeconds: null
  });
  assert.equal(normalizeEpisodeEdit({ title: 't', targetDurationSeconds: '45' }).targetDurationSeconds, 45);
  assert.ok(captureFieldErrors(() => normalizeEpisodeEdit({ title: '' })).title);
  assert.ok(captureFieldErrors(() => normalizeEpisodeEdit({ title: 't', targetDurationSeconds: '0' })).targetDurationSeconds);
  assert.ok(captureFieldErrors(() => normalizeEpisodeEdit({ title: 't', screenplayText: 'x'.repeat(EPISODE_TEXT_MAX_LENGTH + 1) })).screenplayText);
});

test('编辑实体：别名按分隔符拆分并去重，设定字段只取该类型的，名称必填', () => {
  const edit = normalizeEntityEdit(
    { name: '守夜人', aliases: '老陈，阿陈、老陈\n守夜人', description: '', attributes: { identity: ' 身份 ', layout: '无关', voice: '' }, isActive: false },
    'character'
  );
  assert.deepEqual(edit.aliases, ['老陈', '阿陈']);
  assert.deepEqual(edit.attributes, { identity: '身份' });
  assert.equal(edit.isActive, false);
  assert.equal(normalizeEntityEdit({ name: 'x' }, 'scene').isActive, true);

  assert.ok(captureFieldErrors(() => normalizeEntityEdit({ name: '' }, 'prop')).name);
  assert.ok(captureFieldErrors(() => normalizeEntityEdit({ name: 'x', attributes: { appearance: 'y'.repeat(501) } }, 'prop')).appearance);
  assert.ok(captureFieldErrors(() => normalizeEntityEdit({ name: 'x', aliases: 1 }, 'prop')).aliases);
});
