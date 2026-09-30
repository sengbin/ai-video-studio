// ------------------------------------------------------------------------
// 名称：novel-splitter.test.ts
// 说明：小说分段器的自动化测试：按章节、按字数、回退、超长切分和边界情况。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖存储与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN_SEGMENT_CHARS, splitNovel, splitText } from './novel-splitter';

const CHAPTER_MODE = { mode: 'chapter', maxSegmentChars: 1000 } as const;
const LENGTH_MODE = { mode: 'length', maxSegmentChars: 1000 } as const;

/** 生成指定长度的段落文字。 */
function paragraph(length: number, char = '灯'): string {
  return char.repeat(length);
}

test('按章节：识别中文与英文章节标题，序号连续，前言单独成段', () => {
  const text = [
    '序言内容',
    '第一章 灯塔',
    paragraph(200),
    '第二章 信号',
    paragraph(300),
    'Chapter 3 Return',
    paragraph(100)
  ].join('\n');

  const segments = splitNovel(text, CHAPTER_MODE);

  assert.deepEqual(
    segments.map((segment) => [segment.index, segment.title]),
    [
      [1, null],
      [2, '第一章 灯塔'],
      [3, '第二章 信号'],
      [4, 'Chapter 3 Return']
    ]
  );
  assert.ok(segments[1].text.startsWith('第一章 灯塔'));
});

test('按章节：识别 Markdown 标题和带数字的章节', () => {
  const text = ['# 第一部', paragraph(100), '## 第2章 归途', paragraph(100)].join('\n');
  const segments = splitNovel(text, CHAPTER_MODE);
  assert.deepEqual(
    segments.map((segment) => segment.title),
    ['# 第一部', '## 第2章 归途']
  );
});

test('按章节：单章超过上限时在段落处再切分，标题标注续段', () => {
  const text = ['第一章 长章', paragraph(600, '甲'), paragraph(600, '乙'), '第二章 短章', paragraph(100)].join('\n');
  const segments = splitNovel(text, CHAPTER_MODE);

  assert.deepEqual(
    segments.map((segment) => segment.title),
    ['第一章 长章', '第一章 长章（续1）', '第二章 短章']
  );
  assert.ok(segments[0].text.includes('甲') && !segments[0].text.includes('乙'));
  assert.ok(segments.every((segment) => segment.text.length <= 1000));
});

test('按章节：识别不到至少两个章节标题时回退为按字数', () => {
  const text = ['第一章 唯一的章节', paragraph(800), paragraph(800)].join('\n');
  const segments = splitNovel(text, CHAPTER_MODE);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => segment.title === null));
});

test('按字数：在段落边界累积，每段不超过上限', () => {
  const text = [paragraph(400), paragraph(400), paragraph(400), paragraph(400)].join('\n');
  const segments = splitNovel(text, LENGTH_MODE);
  assert.deepEqual(
    segments.map((segment) => segment.text.length),
    [801, 801]
  );
  assert.deepEqual(
    segments.map((segment) => segment.index),
    [1, 2]
  );
});

test('超长单个段落：优先在句子结尾处切分，找不到句号时硬切', () => {
  const sentence = `${paragraph(300)}。`;
  const pieces = splitText(sentence.repeat(5).replace(/\n/g, ''), 700);
  assert.ok(pieces.every((piece) => piece.length <= 700));
  assert.ok(pieces.slice(0, -1).every((piece) => piece.endsWith('。')), '中间片段应在句号处结束');

  const noPunctuation = splitText(paragraph(2500), 1000);
  assert.deepEqual(
    noPunctuation.map((piece) => piece.length),
    [1000, 1000, 500]
  );
});

test('切分不丢失内容：所有段拼起来包含全部正文字符', () => {
  const text = Array.from({ length: 20 }, (_, index) => `第${index + 1}节的内容${paragraph(150, String(index % 10))}`).join('\n');
  const segments = splitNovel(text, LENGTH_MODE);
  const joined = segments.map((segment) => segment.text).join('\n');
  assert.equal(joined.replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('边界：空白全文返回空数组，上限过小抛出范围错误，兼容 CRLF', () => {
  assert.deepEqual(splitNovel('  \n\n ', CHAPTER_MODE), []);
  assert.throws(() => splitNovel('内容', { mode: 'length', maxSegmentChars: MIN_SEGMENT_CHARS - 1 }), RangeError);
  const segments = splitNovel(`第一章 甲\r\n${paragraph(50)}\r\n第二章 乙\r\n${paragraph(50)}`, CHAPTER_MODE);
  assert.equal(segments.length, 2);
  assert.ok(!segments[0].text.includes('\r'));
});
