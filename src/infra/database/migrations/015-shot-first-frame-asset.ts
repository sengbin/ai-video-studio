// ------------------------------------------------------------------------
// 名称：015-shot-first-frame-asset.ts
// 说明：迁移 015：镜头新增“指定首帧的资产”，用于“指定图片作首帧”。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：资产编辑、采用生成版本时资产文件会整体删除重写，文件标识不稳定，所以按资产标识引用，提交时再取该资产的第一张参考图；资产被删除时置空。迁移 003 的 first_frame_asset_file_id 从未写入，SQLite 不能删除带外键的列，保留不用。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const shotFirstFrameAssetMigration: Migration = {
  version: 15,
  name: 'shot-first-frame-asset',
  sql: `
ALTER TABLE shots ADD COLUMN first_frame_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL;
`
};
