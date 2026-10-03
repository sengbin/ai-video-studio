// ------------------------------------------------------------------------
// 名称：sqlite-asset-category-repository.ts
// 说明：资产分类数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：删除分类依赖 assets.category_id 的 ON DELETE SET NULL，归入该分类的资产自动变为未分类。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { AssetKind } from '../../domain/models/asset';
import { AssetCategoryListItem, AssetCategoryRecord } from '../../domain/models/asset-category';
import { AssetCategoryRepository } from '../../domain/ports/asset-category-repository';

/** asset_categories 表的一行。 */
interface AssetCategoryRow {
  readonly id: number;
  readonly kind: AssetKind;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 列表查询的一行：分类加资产数量。 */
interface AssetCategoryListRow extends AssetCategoryRow {
  readonly asset_count: number;
}

function toRecord(row: AssetCategoryRow): AssetCategoryRecord {
  return { id: row.id, kind: row.kind, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** 基于 SQLite 的资产分类仓库。 */
export class SqliteAssetCategoryRepository implements AssetCategoryRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(kind: AssetKind): AssetCategoryListItem[] {
    const rows = this.database
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM assets a WHERE a.category_id = c.id) AS asset_count
           FROM asset_categories c WHERE c.kind = ? ORDER BY c.id`
      )
      .all(kind) as unknown as AssetCategoryListRow[];
    return rows.map((row) => ({ ...toRecord(row), assetCount: row.asset_count }));
  }

  findById(id: number): AssetCategoryRecord | undefined {
    const row = this.database.prepare('SELECT * FROM asset_categories WHERE id = ?').get(id) as unknown as AssetCategoryRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  findByName(kind: AssetKind, name: string): AssetCategoryRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM asset_categories WHERE kind = ? AND name = ?')
      .get(kind, name) as unknown as AssetCategoryRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  countAssets(id: number): number {
    const row = this.database.prepare('SELECT COUNT(*) AS total FROM assets WHERE category_id = ?').get(id) as unknown as { total: number };
    return row.total;
  }

  insert(kind: AssetKind, name: string, timestamp: string): number {
    const result = this.database
      .prepare('INSERT INTO asset_categories (kind, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(kind, name, timestamp, timestamp);
    return Number(result.lastInsertRowid);
  }

  rename(id: number, name: string, timestamp: string): boolean {
    const result = this.database.prepare('UPDATE asset_categories SET name = ?, updated_at = ? WHERE id = ?').run(name, timestamp, id);
    return Number(result.changes) > 0;
  }

  remove(id: number): boolean {
    const result = this.database.prepare('DELETE FROM asset_categories WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
