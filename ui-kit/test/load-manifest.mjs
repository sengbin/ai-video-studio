// ------------------------------------------------------------------------
// 名称：load-manifest.mjs
// 说明：读取界面组件库清单（ui-kit/manifest.json），并给出 src 目录的绝对路径，供测试使用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：只在 Node 端（测试）使用；页面实际加载顺序由 src/app/panels/page-resources.ts 维护，测试会校验两者一致。
// ------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** src 目录的绝对路径，样式与脚本都在其中。 */
export const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

/** 样式，按加载顺序：令牌必须最先，其余依赖令牌。 */
export const styles = manifest.styles;

/** 脚本，按加载顺序：核心必须最先，后面的组件依赖它。 */
export const scripts = manifest.scripts;
