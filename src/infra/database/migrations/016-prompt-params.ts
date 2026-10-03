// ------------------------------------------------------------------------
// 名称：016-prompt-params.ts
// 说明：迁移 016：生成参数新增“负向清单”和“提示词改写”两列。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：两列都为空表示沿用上一级；负向清单的空串表示明确不要负向清单（与空值不同）；提示词改写 0 关闭、1 开启。只加列，已有记录不变。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const promptParamsMigration: Migration = {
  version: 16,
  name: 'prompt-params',
  sql: `
ALTER TABLE generation_profiles ADD COLUMN negative_list TEXT;
ALTER TABLE generation_profiles ADD COLUMN prompt_extend INTEGER CHECK (prompt_extend IS NULL OR prompt_extend IN (0, 1));
`
};
