// ------------------------------------------------------------------------
// 名称：manifest.test.mjs
// 说明：界面组件库清单的测试：清单与 src 目录一一对应，加载顺序满足依赖，源文件都带文件头。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：清单是各页面加载组件库的唯一依据，新增或删除文件时必须同步 manifest.json。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { scripts, sourceRoot, styles } from './load-manifest.mjs';

test('清单与 src 目录下的文件一一对应，没有遗漏、多余或重复', () => {
  const listed = [...styles, ...scripts];
  assert.equal(new Set(listed).size, listed.length, '清单有重复文件');
  assert.deepEqual([...listed].sort(), readdirSync(sourceRoot).sort());
});

test('令牌样式最先加载，核心脚本最先加载', () => {
  assert.equal(styles[0], 'ui-tokens.css');
  assert.equal(scripts[0], 'ui-core.js');
});

test('每个脚本只依赖排在它前面的脚本（按 aiUi.xxx 的使用检查）', () => {
  const providers = {
    'ui-button.js': ['button'],
    'ui-audio-preview.js': ['audioPreview'],
    'ui-input-controls.js': ['textInput', 'textArea'],
    'ui-select.js': ['select'],
    'ui-choice-controls.js': ['radioGroup', 'checkbox', 'checkboxGroup', 'switchControl'],
    'ui-file-picker.js': ['filePicker'],
    'ui-field.js': ['field'],
    'ui-table.js': ['table', 'tableMainCell', 'chip'],
    'ui-dialog.js': ['openDialog', 'alert', 'confirm', 'confirmDelete', 'openPage']
  };
  for (const [index, file] of scripts.entries()) {
    const source = readFileSync(join(sourceRoot, file), 'utf8');
    for (const [providerFile, names] of Object.entries(providers)) {
      if (providerFile === file || scripts.indexOf(providerFile) < index) continue;
      for (const name of names) {
        assert.ok(!new RegExp(`aiUi\\.${name}\\(`).test(source), `${file} 使用了排在它后面的 ${providerFile} 中的 aiUi.${name}`);
      }
    }
  }
});

test('每个源文件都有文件头（名称、说明、作者、日期）', () => {
  for (const file of [...styles, ...scripts]) {
    const head = readFileSync(join(sourceRoot, file), 'utf8').slice(0, 400);
    for (const label of ['名称：', '说明：', '作者：', '日期：']) {
      assert.ok(head.includes(label), `${file} 的文件头缺少“${label}”`);
    }
  }
});
