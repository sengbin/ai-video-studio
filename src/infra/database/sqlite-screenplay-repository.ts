// ------------------------------------------------------------------------
// 名称：sqlite-screenplay-repository.ts
// 说明：剧本包、集与脚本实体数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：structure_json 为 '{}' 表示尚未抽取；merge 不自带事务，必须在确认采用的事务内调用。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ConflictError } from '../../domain/errors';
import {
  EntityEdit,
  EntityKind,
  EntityRecord,
  EpisodeEdit,
  EpisodeRecord,
  Screenplay,
  ScreenplayStructure,
  ScreenplayText
} from '../../domain/models/screenplay';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';

/** 同类型下实体重名时的提示。 */
export const DUPLICATE_ENTITY_NAME_MESSAGE = '同类型下已有同名实体，请换一个名称。';

/** screenplays 表的一行。 */
interface ScreenplayRow {
  readonly run_id: number;
  readonly title: string;
  readonly overview: string;
  readonly full_text: string;
  readonly structure_json: string;
  readonly updated_at: string;
}

/** episodes 表的一行。 */
interface EpisodeRow {
  readonly id: number;
  readonly seq: number;
  readonly title: string;
  readonly synopsis: string;
  readonly screenplay_text: string;
  readonly target_duration_seconds: number | null;
}

/** script_entities 表的一行。 */
interface EntityRow {
  readonly id: number;
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases_json: string;
  readonly description: string;
  readonly attributes_json: string;
  readonly is_active: number;
}

/** 数据库行转剧本包；抽取结果为空对象时 structure 为 null。 */
function toScreenplay(row: ScreenplayRow): Screenplay {
  const structure = JSON.parse(row.structure_json) as Partial<ScreenplayStructure>;
  return {
    runId: row.run_id,
    title: row.title,
    overview: row.overview,
    fullText: row.full_text,
    structure: Array.isArray(structure.episodes) && Array.isArray(structure.entities) ? (structure as ScreenplayStructure) : null,
    updatedAt: row.updated_at
  };
}

function toEpisode(row: EpisodeRow): EpisodeRecord {
  return {
    id: row.id,
    seq: row.seq,
    title: row.title,
    synopsis: row.synopsis,
    screenplayText: row.screenplay_text,
    targetDurationSeconds: row.target_duration_seconds
  };
}

function toEntity(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    aliases: JSON.parse(row.aliases_json) as string[],
    description: row.description,
    attributes: JSON.parse(row.attributes_json) as Record<string, string>,
    isActive: row.is_active === 1
  };
}

/** 基于 SQLite 的剧本仓库。 */
export class SqliteScreenplayRepository implements ScreenplayRepository {
  constructor(private readonly database: DatabaseSync) {}

  find(runId: number): Screenplay | undefined {
    const row = this.database.prepare('SELECT * FROM screenplays WHERE run_id = ?').get(runId) as unknown as ScreenplayRow | undefined;
    return row === undefined ? undefined : toScreenplay(row);
  }

  create(runId: number, text: ScreenplayText, timestamp: string): void {
    this.database
      .prepare(
        `INSERT INTO screenplays (run_id, title, overview, full_text, structure_json, updated_at) VALUES (?, ?, ?, ?, '{}', ?)
         ON CONFLICT (run_id) DO UPDATE SET title = excluded.title, overview = excluded.overview, full_text = excluded.full_text,
           structure_json = '{}', updated_at = excluded.updated_at`
      )
      .run(runId, text.title, text.overview, text.fullText, timestamp);
  }

  saveStructure(runId: number, structure: ScreenplayStructure, timestamp: string): void {
    this.database
      .prepare('UPDATE screenplays SET structure_json = ?, updated_at = ? WHERE run_id = ?')
      .run(JSON.stringify(structure), timestamp, runId);
  }

  clearStructure(runId: number, timestamp: string): void {
    this.database.prepare("UPDATE screenplays SET structure_json = '{}', updated_at = ? WHERE run_id = ?").run(timestamp, runId);
  }

  updateFullText(runId: number, fullText: string, timestamp: string): void {
    this.database.prepare('UPDATE screenplays SET full_text = ?, updated_at = ? WHERE run_id = ?').run(fullText, timestamp, runId);
  }

  listEpisodes(workId: number): EpisodeRecord[] {
    const rows = this.database
      .prepare('SELECT id, seq, title, synopsis, screenplay_text, target_duration_seconds FROM episodes WHERE work_id = ? ORDER BY seq')
      .all(workId) as unknown as EpisodeRow[];
    return rows.map(toEpisode);
  }

  listEntities(workId: number): EntityRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, kind, name, aliases_json, description, attributes_json, is_active FROM script_entities WHERE work_id = ?
         ORDER BY CASE kind WHEN 'character' THEN 0 WHEN 'scene' THEN 1 WHEN 'prop' THEN 2 ELSE 3 END, id`
      )
      .all(workId) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  updateEpisode(workId: number, episodeId: number, edit: EpisodeEdit, timestamp: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE episodes SET title = ?, synopsis = ?, screenplay_text = ?, target_duration_seconds = ?, updated_at = ?
         WHERE id = ? AND work_id = ?`
      )
      .run(edit.title, edit.synopsis, edit.screenplayText, edit.targetDurationSeconds, timestamp, episodeId, workId);
    return Number(result.changes) > 0;
  }

  updateEntity(workId: number, entityId: number, edit: EntityEdit, timestamp: string): boolean {
    const current = this.database
      .prepare('SELECT kind FROM script_entities WHERE id = ? AND work_id = ?')
      .get(entityId, workId) as unknown as { kind: EntityKind } | undefined;
    if (current === undefined) {
      return false;
    }
    const duplicate = this.database
      .prepare('SELECT id FROM script_entities WHERE work_id = ? AND kind = ? AND name = ? AND id <> ?')
      .get(workId, current.kind, edit.name, entityId);
    if (duplicate !== undefined) {
      throw new ConflictError('name', DUPLICATE_ENTITY_NAME_MESSAGE);
    }
    this.database
      .prepare(
        `UPDATE script_entities SET name = ?, aliases_json = ?, description = ?, attributes_json = ?, is_active = ?, updated_at = ?
         WHERE id = ? AND work_id = ?`
      )
      .run(
        edit.name,
        JSON.stringify(edit.aliases),
        edit.description,
        JSON.stringify(edit.attributes),
        edit.isActive ? 1 : 0,
        timestamp,
        entityId,
        workId
      );
    return true;
  }

  merge(runId: number, timestamp: string): void {
    const run = this.database.prepare('SELECT work_id FROM stage_runs WHERE id = ?').get(runId) as unknown as
      | { work_id: number }
      | undefined;
    const structure = this.find(runId)?.structure;
    if (run === undefined || structure === null || structure === undefined) {
      throw new Error(`阶段记录 ${runId} 还没有可合并的抽取结果。`);
    }
    const workId = run.work_id;
    const { episodes, entities } = structure;

    const upsertEpisode = this.database.prepare(
      `INSERT INTO episodes (work_id, seq, title, synopsis, screenplay_text, target_duration_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (work_id, seq) DO UPDATE SET title = excluded.title, synopsis = excluded.synopsis,
         screenplay_text = excluded.screenplay_text, target_duration_seconds = excluded.target_duration_seconds,
         updated_at = excluded.updated_at`
    );
    for (const episode of episodes) {
      upsertEpisode.run(
        workId,
        episode.seq,
        episode.title,
        episode.synopsis,
        episode.screenplayText,
        episode.targetDurationSeconds,
        timestamp,
        timestamp
      );
    }

    // 先全部停用，再把本次出现的实体按（类型，名称）更新或新增，不再出现的保持停用。
    this.database.prepare('UPDATE script_entities SET is_active = 0, updated_at = ? WHERE work_id = ? AND is_active = 1').run(timestamp, workId);
    const upsertEntity = this.database.prepare(
      `INSERT INTO script_entities (work_id, kind, name, aliases_json, description, attributes_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (work_id, kind, name) DO UPDATE SET aliases_json = excluded.aliases_json, description = excluded.description,
         attributes_json = excluded.attributes_json, is_active = excluded.is_active, updated_at = excluded.updated_at`
    );
    for (const entity of entities) {
      upsertEntity.run(
        workId,
        entity.kind,
        entity.name,
        JSON.stringify(entity.aliases),
        entity.description,
        JSON.stringify(entity.attributes),
        entity.isActive ? 1 : 0,
        timestamp,
        timestamp
      );
    }

    this.database.prepare('UPDATE stage_runs SET applied_at = ? WHERE id = ?').run(timestamp, runId);
  }
}
