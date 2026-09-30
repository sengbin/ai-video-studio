// ------------------------------------------------------------------------
// 名称：file-prompt-templates.test.ts
// 说明：提示词文件读取的自动化测试：读取真实模板、换行统一、名称校验、缓存。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：模板目录相对编译产物 out/infra/prompts 定位到扩展根目录。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FilePromptTemplates } from './file-prompt-templates';

const PROMPTS_DIRECTORY = join(resolve(__dirname, '..', '..', '..'), 'resources', 'prompts');

test('读取扩展自带的提示词模板', () => {
  const templates = new FilePromptTemplates(PROMPTS_DIRECTORY);
  assert.match(templates.get('system'), /内容审查/);
  assert.match(templates.get('creative-chapter'), /\{\{seq\}\}/);
});

test('统一为 LF 换行，重复读取使用缓存', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-video-studio-prompts-'));
  try {
    writeFileSync(join(directory, 'demo.md'), '第一行\r\n第二行\r\n');
    const templates = new FilePromptTemplates(directory);
    assert.equal(templates.get('demo'), '第一行\n第二行\n');

    writeFileSync(join(directory, 'demo.md'), '已修改');
    assert.equal(templates.get('demo'), '第一行\n第二行\n', '第二次读取来自缓存');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('名称不合法或模板不存在时报错，不能读取目录之外的文件', () => {
  const templates = new FilePromptTemplates(PROMPTS_DIRECTORY);
  assert.throws(() => templates.get('../package'), /名称不合法/);
  assert.throws(() => templates.get('Sys tem'), /名称不合法/);
  assert.throws(() => templates.get('not-exist'));
});
