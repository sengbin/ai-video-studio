// ------------------------------------------------------------------------
// 名称：sqlite-binding-repository.ts
// 说明：实体绑定数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同一（集，实体，用途）下的主资产由新增、删除、切换时在事务内维护；部分唯一索引保证最多一条主资产。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { AssetKind } from '../../domain/models/asset';
import {
  BindingContext,
  BindingEntityCandidate,
  BindingEntityDetail,
  BindingPurpose,
  BindingRecord,
  NewBinding
} from '../../domain/models/binding';
import { EntityKind } from '../../domain/models/screenplay';
import { BindingRepository } from '../../domain/ports/binding-repository';
import { runInTransaction } from './transaction';

/** 绑定查询的一行：绑定加实体与资产名称。 */
interface BindingRow {
  readonly id: number;
  readonly episode_id: number;
  readonly entity_id: number;
  readonly entity_name: string;
  readonly asset_id: number;
  readonly asset_name: string;
  readonly asset_kind: AssetKind;
  readonly purpose: BindingPurpose;
  readonly is_primary: number;
  readonly note: string;
  readonly created_at: string;
}

const BINDING_SELECT = `SELECT b.id, b.episode_id, b.entity_id, se.name AS entity_name, b.asset_id, a.name AS asset_name,
    a.kind AS asset_kind, b.purpose, b.is_primary, b.note, b.created_at
  FROM entity_bindings b
  JOIN script_entities se ON se.id = b.entity_id
  JOIN assets a ON a.id = b.asset_id`;

function toRecord(row: BindingRow): BindingRecord {
  return {
    id: row.id,
    episodeId: row.episode_id,
    entityId: row.entity_id,
    entityName: row.entity_name,
    assetId: row.asset_id,
    assetName: row.asset_name,
    assetKind: row.asset_kind,
    purpose: row.purpose,
    isPrimary: row.is_primary === 1,
    note: row.note,
    createdAt: row.created_at
  };
}

/** 基于 SQLite 的实体绑定仓库。 */
export class SqliteBindingRepository implements BindingRepository {
  constructor(private readonly database: DatabaseSync) {}

  listByEpisode(episodeId: number): BindingRecord[] {
    const rows = this.database
      .prepare(`${BINDING_SELECT} WHERE b.episode_id = ? ORDER BY se.name, b.purpose, b.is_primary DESC, b.id`)
      .all(episodeId) as unknown as BindingRow[];
    return rows.map(toRecord);
  }

  findById(id: number): BindingRecord | undefined {
    const row = this.database.prepare(`${BINDING_SELECT} WHERE b.id = ?`).get(id) as unknown as BindingRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  findContext(episodeId: number, entityId: number): BindingContext | undefined {
    const row = this.database
      .prepare(
        `SELECT se.kind, se.name
           FROM episodes e
           JOIN script_entities se ON se.work_id = e.work_id
          WHERE e.id = ? AND se.id = ?`
      )
      .get(episodeId, entityId) as unknown as { kind: EntityKind; name: string } | undefined;
    return row === undefined ? undefined : { entityKind: row.kind, entityName: row.name };
  }

  findEntityDetail(episodeId: number, entityId: number): BindingEntityDetail | undefined {
    const row = this.database
      .prepare(
        `SELECT w.project_id, se.kind, se.name, se.description, se.attributes_json
           FROM episodes e
           JOIN works w ON w.id = e.work_id
           JOIN script_entities se ON se.work_id = e.work_id
          WHERE e.id = ? AND se.id = ?`
      )
      .get(episodeId, entityId) as unknown as
      | { project_id: number; kind: EntityKind; name: string; description: string; attributes_json: string }
      | undefined;
    return row === undefined
      ? undefined
      : {
          projectId: row.project_id,
          kind: row.kind,
          name: row.name,
          description: row.description,
          attributes: JSON.parse(row.attributes_json) as Record<string, string>
        };
  }

  findExisting(episodeId: number, entityId: number, assetId: number): BindingRecord | undefined {
    const row = this.database
      .prepare(`${BINDING_SELECT} WHERE b.episode_id = ? AND b.entity_id = ? AND b.asset_id = ?`)
      .get(episodeId, entityId, assetId) as unknown as BindingRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  insert(binding: NewBinding, timestamp: string): number {
    return runInTransaction(this.database, () => {
      const primary = this.database
        .prepare('SELECT id FROM entity_bindings WHERE episode_id = ? AND entity_id = ? AND purpose = ? AND is_primary = 1')
        .get(binding.episodeId, binding.entityId, binding.purpose);
      const result = this.database
        .prepare(
          `INSERT INTO entity_bindings (episode_id, entity_id, asset_id, purpose, is_primary, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(binding.episodeId, binding.entityId, binding.assetId, binding.purpose, primary === undefined ? 1 : 0, binding.note, timestamp);
      return Number(result.lastInsertRowid);
    });
  }

  remove(id: number): boolean {
    return runInTransaction(this.database, () => {
      const current = this.database
        .prepare('SELECT episode_id, entity_id, purpose, is_primary FROM entity_bindings WHERE id = ?')
        .get(id) as unknown as { episode_id: number; entity_id: number; purpose: BindingPurpose; is_primary: number } | undefined;
      if (current === undefined) {
        return false;
      }
      this.database.prepare('DELETE FROM entity_bindings WHERE id = ?').run(id);
      if (current.is_primary === 1) {
        // 主资产被删除时，让最早的一条接任，保证有绑定就有主资产。
        this.database
          .prepare(
            `UPDATE entity_bindings SET is_primary = 1 WHERE id = (
               SELECT id FROM entity_bindings WHERE episode_id = ? AND entity_id = ? AND purpose = ? ORDER BY id LIMIT 1)`
          )
          .run(current.episode_id, current.entity_id, current.purpose);
      }
      return true;
    });
  }

  setPrimary(id: number): boolean {
    return runInTransaction(this.database, () => {
      const current = this.database
        .prepare('SELECT episode_id, entity_id, purpose FROM entity_bindings WHERE id = ?')
        .get(id) as unknown as { episode_id: number; entity_id: number; purpose: BindingPurpose } | undefined;
      if (current === undefined) {
        return false;
      }
      // 部分唯一索引不允许两条主资产同时存在，先取消再设置。
      this.database
        .prepare('UPDATE entity_bindings SET is_primary = 0 WHERE episode_id = ? AND entity_id = ? AND purpose = ?')
        .run(current.episode_id, current.entity_id, current.purpose);
      this.database.prepare('UPDATE entity_bindings SET is_primary = 1 WHERE id = ?').run(id);
      return true;
    });
  }

  listEntityCandidates(episodeId: number): BindingEntityCandidate[] {
    const rows = this.database
      .prepare(
        `SELECT se.id, se.kind, se.name, se.aliases_json
           FROM episodes e JOIN script_entities se ON se.work_id = e.work_id
          WHERE e.id = ? AND se.is_active = 1 ORDER BY se.id`
      )
      .all(episodeId) as unknown as Array<{ id: number; kind: EntityKind; name: string; aliases_json: string }>;
    return rows.map((row) => ({ entityId: row.id, kind: row.kind, name: row.name, aliases: JSON.parse(row.aliases_json) as string[] }));
  }

  episodeExists(episodeId: number): boolean {
    return this.database.prepare('SELECT 1 FROM episodes WHERE id = ?').get(episodeId) !== undefined;
  }
}
