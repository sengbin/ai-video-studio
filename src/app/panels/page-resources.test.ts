// ------------------------------------------------------------------------
// 名称：page-resources.test.ts
// 说明：页面资源清单的自动化测试：清单中的文件都存在，组件库按依赖顺序加载，且与 ui-kit/manifest.json 一致。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；扩展根目录相对编译产物定位。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PROJECT_LIST_PAGE_RESOURCES, PageResources, SIDEBAR_PAGE_RESOURCES } from './page-resources';

/** 编译产物位于 out/app/panels，扩展根目录在其上三级。 */
const EXTENSION_ROOT = resolve(__dirname, '..', '..', '..');
const UI_KIT_PREFIX = 'ui-kit/src/';
const PAGES: ReadonlyArray<readonly [string, PageResources]> = [
  ['项目列表页', PROJECT_LIST_PAGE_RESOURCES],
  ['侧栏页面', SIDEBAR_PAGE_RESOURCES]
];

/** 取页面清单中属于组件库的文件名，保持加载顺序。 */
function uiKitFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.startsWith(UI_KIT_PREFIX)).map((file) => file.slice(UI_KIT_PREFIX.length));
}

test('每个页面清单中的样式与脚本文件都存在', () => {
  for (const [name, page] of PAGES) {
    for (const file of [...page.styles, ...page.scripts]) {
      assert.ok(existsSync(join(EXTENSION_ROOT, ...file.split('/'))), `${name}引用的 ${file} 不存在`);
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
    assert.equal(page.styles[0], 'ui-kit/src/ui-tokens.css', `${name}应先加载令牌样式`);
    assert.equal(page.scripts[0], 'resources/shared/host-bridge.js', `${name}应先加载通信桥`);
    assert.equal(page.scripts[1], 'ui-kit/src/ui-core.js', `${name}应在通信桥之后加载组件核心`);
  }
});

test('页面加载的组件库文件与顺序和 ui-kit/manifest.json 一致，且没有遗漏', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_ROOT, 'ui-kit', 'manifest.json'), 'utf8')) as {
    styles: string[];
    scripts: string[];
  };
  const srcFiles = readdirSync(join(EXTENSION_ROOT, 'ui-kit', 'src')).sort();
  assert.deepEqual([...manifest.styles, ...manifest.scripts].sort(), srcFiles, 'manifest.json 与 ui-kit/src 不一致');
  for (const [name, page] of PAGES) {
    // 侧栏页面不加载基础样式，但组件库样式与脚本仍须完整、顺序一致。
    assert.deepEqual(uiKitFiles(page.styles), manifest.styles, `${name}的组件库样式与清单不一致`);
    assert.deepEqual(uiKitFiles(page.scripts), manifest.scripts, `${name}的组件库脚本与清单不一致`);
  }
});
