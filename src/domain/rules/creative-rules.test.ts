// ------------------------------------------------------------------------
// 名称：creative-rules.test.ts
// 说明：创意阶段规则的自动化测试：参数校验、字数统计、大纲与章节输出校验，以及模型 JSON 提取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖存储与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeneratedOutputError, ValidationError } from '../errors';
import { CreativeParams } from '../models/creative';
import { countWords, normalizeCreativeParams, parseChapter, parseOutline } from './creative-rules';
import { parseModelJson } from './json-output';

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

test('生成参数：最多字数不能小于最少字数', () => {
  const errors = captureFieldErrors(() =>
    normalizeCreativeParams({ chapterMinWords: 1000, chapterMaxWords: 500, maxChapters: 5 })
  );
  assert.match(errors.chapterMaxWords, /不能小于最少字数（1000）/);
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
    { seq: 1, title: '开端', summary: '守夜人上岗' },
    { seq: 2, title: '转折', summary: '收到信号' }
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

test('章节：字数在范围内则通过并去除首尾空白', () => {
  const content = '灯'.repeat(150);
  assert.deepEqual(parseChapter({ title: ' 开端 ', content: `\n${content}\n` }, 2, PARAMS), {
    seq: 2,
    title: '开端',
    content
  });
});

test('章节：字数过少或过多时给出可反馈给模型的说明', () => {
  assert.match(captureIssues(() => parseChapter({ title: '甲', content: '灯'.repeat(50) }, 1, PARAMS)).join('；'), /50 字，少于下限 100 字/);
  assert.match(captureIssues(() => parseChapter({ title: '甲', content: '灯'.repeat(300) }, 1, PARAMS)).join('；'), /300 字，超过上限 200 字/);
});

test('章节：标题或正文缺失、不是对象时报错', () => {
  assert.equal(captureIssues(() => parseChapter({ content: '' }, 1, PARAMS)).length, 2);
  assert.match(captureIssues(() => parseChapter('正文', 1, PARAMS)).join('；'), /title 和 content/);
});

test('模型 JSON：整段、代码块、夹带说明文字的输出都能提取', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('好的，结果如下：\n{"a":[1,2]}\n希望有帮助。'), { a: [1, 2] });
  assert.deepEqual(parseModelJson('结果：[{"title":"甲"}] 完毕'), [{ title: '甲' }]);
});

test('模型 JSON：合法的 JSON 字面量（如 null、0）不被当作解析失败', () => {
  assert.equal(parseModelJson('null'), null);
  assert.equal(parseModelJson('0'), 0);
});

test('模型 JSON：无法解析时抛出可反馈给模型的输出错误', () => {
  assert.match(captureIssues(() => parseModelJson('没有任何 JSON')).join('；'), /不是合法的 JSON/);
  assert.match(captureIssues(() => parseModelJson('{"a": 1')).join('；'), /不是合法的 JSON/);
});
