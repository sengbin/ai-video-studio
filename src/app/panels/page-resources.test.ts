// ------------------------------------------------------------------------
// 名称：page-resources.test.ts
// 说明：页面资源清单的自动化测试：清单中的文件都存在，组件库按依赖顺序加载。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；resources 目录相对编译产物定位。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { FORM_PAGE_RESOURCES, PROJECT_LIST_PAGE_RESOURCES, PageResources, SIDEBAR_PAGE_RESOURCES } from './page-resources';

/** 编译产物位于 out/app/panels，resources 在扩展根目录。 */
const RESOURCES_ROOT = resolve(__dirname, '..', '..', '..', 'resources');
const PAGES: ReadonlyArray<readonly [string, PageResources]> = [
  ['表单页面', FORM_PAGE_RESOURCES],
  ['项目列表页', PROJECT_LIST_PAGE_RESOURCES],
  ['侧栏页面', SIDEBAR_PAGE_RESOURCES]
];

test('每个页面清单中的样式与脚本文件都存在', () => {
  for (const [name, page] of PAGES) {
    for (const file of [...page.styles, ...page.scripts]) {
      assert.ok(existsSync(join(RESOURCES_ROOT, ...file.split('/'))), `${name}引用的 ${file} 不存在`);
    }
  }
});

test('清单没有重复文件', () => {
  for (const [name, page] of PAGES) {
    assert.equal(new Set(page.styles).size, page.styles.length, `${name}的样式有重复`);
    assert.equal(new Set(page.scripts).size, page.scripts.length, `${name}的脚本有重复`);
  }
});

test('令牌样式最先加载，通信桥与组件核心先于其他脚本', () => {
  for (const [name, page] of PAGES) {
    assert.equal(page.styles[0], 'shared/ui/ui-tokens.css', `${name}应先加载令牌样式`);
    assert.equal(page.scripts[0], 'shared/host-bridge.js', `${name}应先加载通信桥`);
    assert.equal(page.scripts[1], 'shared/ui/ui-core.js', `${name}应在通信桥之后加载组件核心`);
  }
});

test('组件库目录下的每个脚本和样式都被页面使用（避免遗漏或残留）', () => {
  const used = new Set(PAGES.flatMap(([, page]) => [...page.styles, ...page.scripts]));
  const uiFiles = readdirSync(join(RESOURCES_ROOT, 'shared', 'ui')).map((name) => `shared/ui/${name}`);
  for (const file of uiFiles) {
    assert.ok(used.has(file), `${file} 没有被任何页面引用`);
  }
});
