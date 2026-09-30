// ------------------------------------------------------------------------
// 名称：creative-output-tools.test.ts
// 说明：创意输出工具定义的自动化测试：大纲的 sources 字段随素材类型变化，各工具都允许用 refused 拒绝。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：纯数据测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUBMIT_CHAPTER_TOOL, SUBMIT_SUMMARY_TOOL, createOutlineTool } from './creative-output-tools';

/** 取出大纲工具中单章的 schema。 */
function chapterItem(novel: boolean): { properties: Record<string, unknown>; required: string[] } {
  const schema = createOutlineTool(novel).inputSchema as { properties: { chapters: { items: never } } };
  return schema.properties.chapters.items;
}

test('大纲工具：小说素材的每章必须带 sources，其他素材没有该字段', () => {
  assert.ok('sources' in chapterItem(true).properties);
  assert.deepEqual(chapterItem(true).required, ['title', 'summary', 'sources']);
  assert.ok(!('sources' in chapterItem(false).properties));
  assert.deepEqual(chapterItem(false).required, ['title', 'summary']);
});

test('输出工具：名称各不相同，且都带 refused 字段用于拒绝生成', () => {
  const tools = [SUBMIT_SUMMARY_TOOL, SUBMIT_CHAPTER_TOOL, createOutlineTool(false)];
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.ok('refused' in (tool.inputSchema.properties as Record<string, unknown>));
  }
});
