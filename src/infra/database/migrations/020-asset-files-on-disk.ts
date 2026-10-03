// ------------------------------------------------------------------------
// 名称：020-asset-files-on-disk.ts
// 说明：迁移 020：资产的图片、音频内容不再存数据库，改存磁盘文件，表里只记录相对路径；资产文件区分上传与生成来源，资产记录当前使用的来源。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：产品尚未正式发布，旧的图片、音频内容按用户要求直接丢弃：清空资产文件与全部生成版本（版本文件随版本级联删除），资产的文字内容、分类和绑定保留；旧数据已有的资产默认使用“生成”来源。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const assetFilesOnDiskMigration: Migration = {
  version: 20,
  name: 'asset-files-on-disk',
  sql: `
-- 旧内容存在数据库里，没有对应的磁盘文件，直接丢弃；assets.adopted_version_id 与镜头组首帧引用会随之置空。
DELETE FROM asset_versions;
DELETE FROM asset_files;

ALTER TABLE asset_files DROP COLUMN content;
ALTER TABLE asset_files ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
ALTER TABLE asset_files ADD COLUMN source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated'));
CREATE INDEX asset_files_path_idx ON asset_files (file_path);

ALTER TABLE asset_version_files DROP COLUMN content;
ALTER TABLE asset_version_files ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
CREATE INDEX asset_version_files_path_idx ON asset_version_files (file_path);

ALTER TABLE assets ADD COLUMN file_source TEXT NOT NULL DEFAULT 'generated' CHECK (file_source IN ('upload', 'generated'));
`
};
