// ------------------------------------------------------------------------
// 名称：work-rules.test.ts
// 说明：作品创建规则的自动化测试：名称与形态、灵感图片和小说原文的类型、数量、大小、编码校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖 VS Code；文件以表单传输格式（JSON 文本，Base64 内容）构造。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../errors';
import {
  IMAGE_FIELD_KEY,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_FILES,
  NOVEL_FIELD_KEY,
  NOVEL_MAX_BYTES,
  WORK_NAME_MAX_LENGTH,
  detectImageMime,
  normalizeWorkCreation
} from './work-rules';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

/** 构造一个表单传输格式的文件条目。 */
function fileItem(name: string, bytes: Uint8Array | number[]) {
  const buffer = Buffer.from(bytes);
  return { name, mimeType: 'application/octet-stream', size: buffer.length, data: buffer.toString('base64') };
}

/** 文件列表转为表单的 JSON 文本。 */
function files(...items: Array<ReturnType<typeof fileItem>>): string {
  return JSON.stringify(items);
}

/** 捕获校验错误的字段错误表。 */
function fieldErrorsOf(action: () => unknown): Record<string, string> {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    return { ...error.fieldErrors };
  }
  assert.fail('应当抛出校验错误');
}

test('名称与形态：接受界面名称与内部键，名称去除首尾空白', () => {
  const byLabel = normalizeWorkCreation({ workName: '  雨夜来客 ', kind: '多集短片' }, 'text');
  assert.deepEqual(byLabel, { input: { name: '雨夜来客', kind: 'series', sourceType: 'text' }, sources: [] });
  assert.equal(normalizeWorkCreation({ workName: '甲', kind: 'single' }, 'text').input.kind, 'single');
});

test('名称与形态：名称必填且不超长，形态必须选择', () => {
  assert.equal(fieldErrorsOf(() => normalizeWorkCreation({ workName: '', kind: '单个短视频' }, 'text')).workName, '作品名称不能为空。');
  const tooLong = '长'.repeat(WORK_NAME_MAX_LENGTH + 1);
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ workName: tooLong, kind: '单个短视频' }, 'text')).workName, /不能超过/);
  assert.equal(fieldErrorsOf(() => normalizeWorkCreation({ workName: '甲', kind: '' }, 'text')).kind, '请选择作品形态。');
});

test('灵感图片：按文件头识别 PNG、JPEG、WebP，保持上传顺序', () => {
  const result = normalizeWorkCreation(
    {
      workName: '甲',
      kind: '单个短视频',
      [IMAGE_FIELD_KEY]: files(fileItem('a.png', PNG_HEADER), fileItem('b.jpg', JPEG_HEADER), fileItem('c.webp', WEBP_HEADER))
    },
    'image'
  );
  assert.deepEqual(
    result.sources.map((source) => [source.kind, source.fileName, source.mime]),
    [
      ['image', 'a.png', 'image/png'],
      ['image', 'b.jpg', 'image/jpeg'],
      ['image', 'c.webp', 'image/webp']
    ]
  );
  assert.equal(detectImageMime(Uint8Array.from([1, 2, 3])), null);
});

test('灵感图片：至少 1 张、最多 10 张，内容不是图片、路径名只取文件名', () => {
  const base = { workName: '甲', kind: '单个短视频' };
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: '' }, 'image'))[IMAGE_FIELD_KEY], /至少/);
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base }, 'image'))[IMAGE_FIELD_KEY], /至少/);

  const many = files(...Array.from({ length: IMAGE_MAX_FILES + 1 }, (_, index) => fileItem(`${index}.png`, PNG_HEADER)));
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: many }, 'image'))[IMAGE_FIELD_KEY], /最多 10 张/);

  const fake = files(fileItem('假图.png', [1, 2, 3, 4]));
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: fake }, 'image'))[IMAGE_FIELD_KEY], /不是有效的 PNG/);

  const nested = normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: files(fileItem('C:\\pics\\..\\a.png', PNG_HEADER)) }, 'image');
  assert.equal(nested.sources[0].fileName, 'a.png');
});

test('灵感图片：超过大小上限的文件被拒绝，空文件被拒绝', () => {
  const base = { workName: '甲', kind: '单个短视频' };
  const big = Buffer.alloc(IMAGE_MAX_BYTES + 1);
  PNG_HEADER.forEach((byte, index) => (big[index] = byte));
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: files(fileItem('big.png', big)) }, 'image'))[IMAGE_FIELD_KEY], /超过 10 MB/);
  assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: files(fileItem('empty.png', [])) }, 'image'))[IMAGE_FIELD_KEY], /空文件/);
});

test('文件内容格式：不是 JSON、缺少数据或 Base64 不合法时按格式错误处理', () => {
  const base = { workName: '甲', kind: '单个短视频' };
  for (const bad of ['不是 JSON', '{"a":1}', '[1]', '[{"name":"a.png"}]', '[{"name":"a.png","data":"@@@@"}]']) {
    assert.match(fieldErrorsOf(() => normalizeWorkCreation({ ...base, [IMAGE_FIELD_KEY]: bad }, 'image'))[IMAGE_FIELD_KEY], /格式不正确/, bad);
  }
});

test('小说原文：读取 UTF-8 文本，去掉开头的 BOM，Markdown 使用对应类型', () => {
  const base = { workName: '甲', kind: '多集短片' };
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章 开始\n很久以前。', 'utf8')]);
  const result = normalizeWorkCreation({ ...base, [NOVEL_FIELD_KEY]: files(fileItem('原作.txt', withBom)) }, 'novel');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].kind, 'novel_text');
  assert.equal(result.sources[0].mime, 'text/plain');
  assert.equal(Buffer.from(result.sources[0].content).toString('utf8'), '第一章 开始\n很久以前。');

  const markdown = normalizeWorkCreation({ ...base, [NOVEL_FIELD_KEY]: files(fileItem('a.MD', Buffer.from('# 标题\n正文'))) }, 'novel');
  assert.equal(markdown.sources[0].mime, 'text/markdown');
});

test('小说原文：数量、扩展名、编码、内容与大小都被校验', () => {
  const base = { workName: '甲', kind: '多集短片' };
  const novel = (value: string) => fieldErrorsOf(() => normalizeWorkCreation({ ...base, [NOVEL_FIELD_KEY]: value }, 'novel'))[NOVEL_FIELD_KEY];

  assert.match(novel(''), /选择 1 个/);
  assert.match(novel(files(fileItem('a.txt', Buffer.from('甲')), fileItem('b.txt', Buffer.from('乙')))), /选择 1 个/);
  assert.match(novel(files(fileItem('a.docx', Buffer.from('甲')))), /只支持/);
  assert.match(novel(files(fileItem('a.txt', [0xff, 0xfe, 0x41, 0x00]))), /UTF-8/);
  assert.match(novel(files(fileItem('a.txt', Buffer.from('   \n  ')))), /没有可用的文字内容/);
  assert.match(novel(files(fileItem('a.txt', Buffer.from('文本\u0000二进制')))), /UTF-8/);
  assert.match(novel(files(fileItem('a.txt', Buffer.alloc(NOVEL_MAX_BYTES + 1, 0x61)))), /超过 5 MB/);
});

test('文字灵感不读取文件字段；名称与文件错误一并返回', () => {
  const ignored = normalizeWorkCreation({ workName: '甲', kind: '单个短视频', [IMAGE_FIELD_KEY]: '坏数据' }, 'text');
  assert.deepEqual(ignored.sources, []);

  const errors = fieldErrorsOf(() => normalizeWorkCreation({ workName: '', kind: '', [IMAGE_FIELD_KEY]: '' }, 'image'));
  assert.deepEqual(Object.keys(errors).sort(), ['images', 'kind', 'workName']);
});
