// ------------------------------------------------------------------------
// 名称：013-asset-categories.ts
// 说明：迁移 013：新增资产分类表，资产增加所属分类字段。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：分类属于某个资产类型，（类型，名称）唯一；assets.category_id 为空表示不分类，分类被删除时资产自动变为未分类；已有资产全部是未分类。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const assetCategoriesMigration: Migration = {
  version: 13,
  name: 'asset-categories',
  sql: `
CREATE TABLE asset_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'effect', 'audio')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);

ALTER TABLE assets ADD COLUMN category_id INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL;

CREATE INDEX assets_category_idx ON assets (category_id);
`
};
