// ------------------------------------------------------------------------
// 名称：creative-rules.test.ts
// 说明：创意阶段规则的自动化测试：参数校验、字数统计、大纲与章节输出校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖存储与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedOutputError, ValidationError } from '../errors';
import { CreativeParams } from '../models/creative';
import { countWords, normalizeCreativeParams, parseChapter, parseOutline, parseSummary } from './creative-rules';

const PARAMS: CreativeParams = {
  idea: null,
  genre: null,
  tone: null,
  chapterMinWords: 100,
  chapterMaxWords: 200,
  maxChapters: 3,
  preserve: null,
  adjust: null,
  extra: null
};

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

test('字数统计：汉字逐个计数，英文与数字按词计数，忽略标点和空白', () => {
  assert.equal(countWords('灯塔，守夜人。'), 5);
  assert.equal(countWords('Hello, world! 42 times'), 4);
  assert.equal(countWords("don't stop-motion"), 2);
  assert.equal(countWords('灯塔 lighthouse 2 号'), 5);
  assert.equal(countWords('  \n…—'), 0);
});

test('生成参数：数字字段接受数字或文本，可选文本为空时为 null', () => {
  const params = normalizeCreativeParams({
    idea: ' 灯塔守夜人 ',
    genre: '',
    chapterMinWords: '1000',
    chapterMaxWords: 2500,
    maxChapters: '20'
  });
  assert.equal(params.idea, '灯塔守夜人');
  assert.equal(params.genre, null);
  assert.equal(params.chapterMinWords, 1000);
  assert.equal(params.chapterMaxWords, 2500);
  assert.equal(params.maxChapters, 20);
});

test('生成参数：必填数字缺失或越界时逐项报错', () => {
  const errors = captureFieldErrors(() => normalizeCreativeParams({ chapterMinWords: '50', maxChapters: '101' }));
  assert.match(errors.chapterMinWords, /100 到/);
  assert.match(errors.chapterMaxWords, /不能为空/);
  assert.match(errors.maxChapters, /1 到 100/);
});

test('生成参数：最多字数至少比最少字数多 50 字', () => {
  const errors = captureFieldErrors(() =>
    normalizeCreativeParams({ chapterMinWords: 1000, chapterMaxWords: 500, maxChapters: 5 })
  );
  assert.match(errors.chapterMaxWords, /多 50 字（不小于 1050）/);
  for (const chapterMaxWords of [100, 149]) {
    assert.match(
      captureFieldErrors(() => normalizeCreativeParams({ chapterMinWords: 100, chapterMaxWords, maxChapters: 1 })).chapterMaxWords,
      /不小于 150/
    );
  }
  assert.equal(normalizeCreativeParams({ chapterMinWords: 100, chapterMaxWords: 150, maxChapters: 1 }).chapterMaxWords, 150);
});

test('生成参数：文本超长和非法数字都会报错', () => {
  const errors = captureFieldErrors(() =>
    normalizeCreativeParams({ idea: 'a'.repeat(2001), chapterMinWords: '一百', chapterMaxWords: 200, maxChapters: 1.5 })
  );
  assert.match(errors.idea, /不能超过 2000 字/);
  assert.match(errors.chapterMinWords, /必须是整数/);
  assert.match(errors.maxChapters, /必须是整数/);
});

test('大纲：接受 chapters 对象或直接的数组，序号按顺序从 1 分配', () => {
  const chapters = [
    { title: ' 开端 ', summary: '守夜人上岗' },
    { title: '转折', summary: '收到信号' }
  ];
  const fromObject = parseOutline({ chapters }, PARAMS);
  assert.deepEqual(fromObject, [
    { seq: 1, title: '开端', summary: '守夜人上岗', sources: [] },
    { seq: 2, title: '转折', summary: '收到信号', sources: [] }
  ]);
  assert.deepEqual(parseOutline(chapters, PARAMS), fromObject);
});

test('大纲：章数超过上限、为空或字段缺失时给出逐条问题', () => {
  const tooMany = Array.from({ length: 4 }, (_, index) => ({ title: `第${index}章`, summary: '梗概' }));
  assert.match(captureIssues(() => parseOutline(tooMany, PARAMS)).join('；'), /超过上限 3 章/);
  assert.match(captureIssues(() => parseOutline({ chapters: [] }, PARAMS)).join('；'), /至少需要 1 章/);
  const issues = captureIssues(() => parseOutline({ chapters: [{ title: '', summary: '梗概' }, { title: '标题' }] }, PARAMS));
  assert.equal(issues.length, 2);
  assert.match(issues[0], /第 1 章标题/);
  assert.match(issues[1], /第 2 章梗概/);
  assert.match(captureIssues(() => parseOutline('不是大纲', PARAMS)).join('；'), /chapters 数组/);
});

test('章节：通过并去除首尾空白', () => {
  const content = '灯'.repeat(150);
  assert.deepEqual(parseChapter({ title: ' 开端 ', content: `\n${content}\n` }, 2), {
    seq: 2,
    title: '开端',
    content
  });
});

test('章节：字数过少或过多也接受，不做字数校验', () => {
  assert.equal(parseChapter({ title: '甲', content: '灯'.repeat(5) }, 1).content.length, 5);
  assert.equal(parseChapter({ title: '甲', content: '灯'.repeat(3000) }, 1).content.length, 3000);
});

test('章节：标题或正文缺失、不是对象时报错', () => {
  assert.equal(captureIssues(() => parseChapter({ content: '' }, 1)).length, 2);
  assert.match(captureIssues(() => parseChapter('正文', 1)).join('；'), /title 和 content/);
});

test('大纲（小说）：每章必须给出合法的原文段序号，去重并排序', () => {
  const outline = parseOutline(
    {
      chapters: [
        { title: '甲', summary: '梗概', sources: [3, 1, 3] },
        { title: '乙', summary: '梗概', sources: [2] }
      ]
    },
    PARAMS,
    3
  );
  assert.deepEqual(
    outline.map((item) => item.sources),
    [[1, 3], [2]]
  );

  const issues = captureIssues(() =>
    parseOutline(
      {
        chapters: [
          { title: '甲', summary: '梗概' },
          { title: '乙', summary: '梗概', sources: [4] },
          { title: '丙', summary: '梗概', sources: [] }
        ]
      },
      PARAMS,
      3
    )
  );
  assert.equal(issues.length, 3);
  assert.match(issues[0], /第 1 章的 sources/);
});

test('要点文字：必须有非空的 summary，且不能过长', () => {
  assert.equal(parseSummary({ summary: ' 要点 ' }), '要点');
  assert.match(captureIssues(() => parseSummary({ summary: '  ' })).join('；'), /summary 不能为空/);
  assert.match(captureIssues(() => parseSummary('要点')).join('；'), /summary/);
  assert.match(captureIssues(() => parseSummary({ summary: '长'.repeat(2001) })).join('；'), /超过上限 2000 字/);
});
