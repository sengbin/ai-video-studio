// ------------------------------------------------------------------------
// 名称：sqlite-storyboard-repository.ts
// 说明：分镜脚本、镜头、镜头出场实体与镜头声音数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：整份保存与单个镜头修改都在事务内完成，不能在已有事务中调用。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { FirstFrameMode, GroupLayoutEntry, ShotDraft, ShotEdit, ShotGroup, ShotRecord, SoundDraft, SoundKind, SoundRecord, StoryboardScript } from '../../domain/models/storyboard';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { runInTransaction } from './transaction';

/** 重排序号时临时移出正常范围的偏移量。 */
const SEQ_SHIFT = 1000000;

/** storyboard_scripts 表的一行。 */
interface ScriptRow {
  readonly id: number;
  readonly run_id: number;
  readonly episode_id: number;
}

/** shots 表的一行。 */
interface ShotRow {
  readonly id: number;
  readonly seq: number;
  readonly scene_label: string;
  readonly shot_size: string;
  readonly camera_angle: string;
  readonly action: string;
  readonly camera_movement: string;
  readonly duration_seconds: number;
  readonly transition: string;
  readonly continuity_note: string;
  readonly first_frame_mode: FirstFrameMode;
  readonly prompt_zh: string;
  readonly prompt_en: string;
}

/** shot_sounds 表的一行。 */
interface SoundRow {
  readonly id: number;
  readonly shot_id: number;
  readonly kind: SoundKind;
  readonly speaker_entity_id: number | null;
  readonly text: string;
  readonly delivery: string;
  readonly start_offset_seconds: number | null;
  readonly duration_seconds: number | null;
  readonly is_enabled: number;
}

function toSound(row: SoundRow): SoundRecord {
  return {
    id: row.id,
    kind: row.kind,
    speakerEntityId: row.speaker_entity_id,
    text: row.text,
    delivery: row.delivery,
    startOffsetSeconds: row.start_offset_seconds,
    durationSeconds: row.duration_seconds,
    isEnabled: row.is_enabled === 1
  };
}

/** 基于 SQLite 的分镜脚本仓库。 */
export class SqliteStoryboardRepository implements StoryboardRepository {
  constructor(private readonly database: DatabaseSync) {}

  find(runId: number): StoryboardScript | undefined {
    const row = this.database.prepare('SELECT id, run_id, episode_id FROM storyboard_scripts WHERE run_id = ?').get(runId) as unknown as
      | ScriptRow
      | undefined;
    return row === undefined ? undefined : { id: row.id, runId: row.run_id, episodeId: row.episode_id };
  }

  save(runId: number, episodeId: number, shots: readonly ShotDraft[], timestamp: string): void {
    runInTransaction(this.database, () => {
      this.database.prepare('DELETE FROM storyboard_scripts WHERE run_id = ?').run(runId);
      const script = this.database
        .prepare('INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (?, ?, ?)')
        .run(episodeId, runId, timestamp);
      const scriptId = Number(script.lastInsertRowid);
      const insertShot = this.database.prepare(
        `INSERT INTO shots
           (storyboard_script_id, seq, scene_label, shot_size, camera_angle, action, camera_movement, duration_seconds,
            transition, continuity_note, first_frame_mode, prompt_zh, prompt_en, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const shot of shots) {
        const inserted = insertShot.run(
          scriptId,
          shot.seq,
          shot.sceneLabel,
          shot.shotSize,
          shot.cameraAngle,
          shot.action,
          shot.cameraMovement,
          shot.durationSeconds,
          shot.transition,
          shot.continuityNote,
          shot.firstFrameMode,
          shot.promptZh,
          shot.promptEn,
          timestamp,
          timestamp
        );
        this.replaceRelations(Number(inserted.lastInsertRowid), shot.entityIds, shot.sounds);
      }
    });
  }

  listShots(runId: number): ShotRecord[] {
    const shotRows = this.database
      .prepare(
        `SELECT s.* FROM shots s JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id
         WHERE ss.run_id = ? ORDER BY s.seq`
      )
      .all(runId) as unknown as ShotRow[];
    if (shotRows.length === 0) {
      return [];
    }
    const entityRows = this.database
      .prepare(
        `SELECT se.shot_id, se.entity_id FROM shot_entities se
         JOIN shots s ON s.id = se.shot_id JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id
         WHERE ss.run_id = ? ORDER BY se.shot_id, se.rowid`
      )
      .all(runId) as unknown as Array<{ shot_id: number; entity_id: number }>;
    const soundRows = this.database
      .prepare(
        `SELECT so.* FROM shot_sounds so
         JOIN shots s ON s.id = so.shot_id JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id
         WHERE ss.run_id = ? ORDER BY so.shot_id, so.seq`
      )
      .all(runId) as unknown as SoundRow[];

    return shotRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      sceneLabel: row.scene_label,
      shotSize: row.shot_size,
      cameraAngle: row.camera_angle,
      action: row.action,
      cameraMovement: row.camera_movement,
      durationSeconds: row.duration_seconds,
      transition: row.transition,
      continuityNote: row.continuity_note,
      firstFrameMode: row.first_frame_mode,
      entityIds: entityRows.filter((entity) => entity.shot_id === row.id).map((entity) => entity.entity_id),
      sounds: soundRows.filter((sound) => sound.shot_id === row.id).map(toSound),
      promptZh: row.prompt_zh,
      promptEn: row.prompt_en
    }));
  }

  countShots(runId: number): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM shots s JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id WHERE ss.run_id = ?`
      )
      .get(runId) as unknown as { total: number };
    return row.total;
  }

  updateShot(runId: number, shotId: number, edit: ShotEdit, timestamp: string): boolean {
    return runInTransaction(this.database, () => {
      const owned = this.database
        .prepare(
          `SELECT s.id FROM shots s JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id WHERE s.id = ? AND ss.run_id = ?`
        )
        .get(shotId, runId);
      if (owned === undefined) {
        return false;
      }
      this.database
        .prepare(
          `UPDATE shots SET scene_label = ?, shot_size = ?, camera_angle = ?, action = ?, camera_movement = ?, duration_seconds = ?,
             transition = ?, continuity_note = ?, first_frame_mode = ?, prompt_zh = ?, prompt_en = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          edit.sceneLabel,
          edit.shotSize,
          edit.cameraAngle,
          edit.action,
          edit.cameraMovement,
          edit.durationSeconds,
          edit.transition,
          edit.continuityNote,
          edit.firstFrameMode,
          edit.promptZh,
          edit.promptEn,
          timestamp,
          shotId
        );
      this.database.prepare('DELETE FROM shot_entities WHERE shot_id = ?').run(shotId);
      this.database.prepare('DELETE FROM shot_sounds WHERE shot_id = ?').run(shotId);
      this.replaceRelations(shotId, edit.entityIds, edit.sounds);
      return true;
    });
  }

  insertShot(runId: number, edit: ShotEdit, timestamp: string): number {
    return runInTransaction(this.database, () => {
      const script = this.find(runId);
      if (script === undefined) {
        throw new Error(`阶段记录 ${runId} 还没有分镜脚本。`);
      }
      const inserted = this.database
        .prepare(
          `INSERT INTO shots
             (storyboard_script_id, seq, scene_label, shot_size, camera_angle, action, camera_movement, duration_seconds,
              transition, continuity_note, first_frame_mode, prompt_zh, prompt_en, created_at, updated_at)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM shots WHERE storyboard_script_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          script.id,
          script.id,
          edit.sceneLabel,
          edit.shotSize,
          edit.cameraAngle,
          edit.action,
          edit.cameraMovement,
          edit.durationSeconds,
          edit.transition,
          edit.continuityNote,
          edit.firstFrameMode,
          edit.promptZh,
          edit.promptEn,
          timestamp,
          timestamp
        );
      const shotId = Number(inserted.lastInsertRowid);
      this.replaceRelations(shotId, edit.entityIds, edit.sounds);
      return shotId;
    });
  }

  deleteShot(runId: number, shotId: number, timestamp: string): boolean {
    return runInTransaction(this.database, () => {
      const current = this.database
        .prepare(
          `SELECT s.seq, s.storyboard_script_id AS script_id FROM shots s JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id
           WHERE s.id = ? AND ss.run_id = ?`
        )
        .get(shotId, runId) as unknown as { seq: number; script_id: number } | undefined;
      if (current === undefined) {
        return false;
      }
      this.database.prepare('DELETE FROM shots WHERE id = ?').run(shotId);
      // 序号有唯一约束，先整体移出范围再前移，避免逐行更新时与未处理的行冲突。
      this.database
        .prepare('UPDATE shots SET seq = seq + ? WHERE storyboard_script_id = ? AND seq > ?')
        .run(SEQ_SHIFT, current.script_id, current.seq);
      this.database
        .prepare('UPDATE shots SET seq = seq - ? - 1 WHERE storyboard_script_id = ? AND seq > ?')
        .run(SEQ_SHIFT, current.script_id, SEQ_SHIFT);
      this.database
        .prepare(
          `UPDATE shots SET first_frame_mode = 'none', updated_at = ?
           WHERE storyboard_script_id = ? AND seq = 1 AND first_frame_mode = 'prev_tail'`
        )
        .run(timestamp, current.script_id);
      return true;
    });
  }

  listGroups(runId: number): ShotGroup[] {
    const groupRows = this.database
      .prepare(
        `SELECT g.id, g.seq FROM shot_groups g JOIN storyboard_scripts ss ON ss.id = g.storyboard_script_id
         WHERE ss.run_id = ? ORDER BY g.seq`
      )
      .all(runId) as unknown as Array<{ id: number; seq: number }>;
    const shotRows = this.database
      .prepare(
        `SELECT s.id, s.group_id FROM shots s JOIN storyboard_scripts ss ON ss.id = s.storyboard_script_id
         WHERE ss.run_id = ? AND s.group_id IS NOT NULL ORDER BY s.seq`
      )
      .all(runId) as unknown as Array<{ id: number; group_id: number }>;
    return groupRows.map((group) => ({
      id: group.id,
      seq: group.seq,
      shotIds: shotRows.filter((shot) => shot.group_id === group.id).map((shot) => shot.id)
    }));
  }

  applyGroupLayout(runId: number, layout: readonly GroupLayoutEntry[], timestamp: string): void {
    runInTransaction(this.database, () => {
      const script = this.find(runId);
      if (script === undefined) {
        throw new Error(`阶段记录 ${runId} 还没有分镜脚本。`);
      }
      const existing = new Set(
        (this.database.prepare('SELECT id FROM shot_groups WHERE storyboard_script_id = ?').all(script.id) as unknown as Array<{ id: number }>).map(
          (row) => row.id
        )
      );
      const kept = new Set<number>();
      for (const entry of layout) {
        if (entry.groupId !== null) {
          if (!existing.has(entry.groupId)) {
            throw new Error(`镜头组 ${entry.groupId} 不属于阶段记录 ${runId}。`);
          }
          kept.add(entry.groupId);
        }
      }
      // 没有出现在布局里的组连同它的生成记录一起删除。
      for (const id of existing) {
        if (!kept.has(id)) {
          this.database.prepare('DELETE FROM shot_groups WHERE id = ?').run(id);
        }
      }
      // 序号有唯一约束，先整体移出范围，再按布局顺序重新编号。
      this.database.prepare('UPDATE shot_groups SET seq = seq + ? WHERE storyboard_script_id = ?').run(SEQ_SHIFT, script.id);
      this.database.prepare('UPDATE shots SET group_id = NULL WHERE storyboard_script_id = ?').run(script.id);
      layout.forEach((entry, index) => {
        let groupId = entry.groupId;
        if (groupId === null) {
          const inserted = this.database
            .prepare('INSERT INTO shot_groups (storyboard_script_id, seq, created_at) VALUES (?, ?, ?)')
            .run(script.id, index + 1, timestamp);
          groupId = Number(inserted.lastInsertRowid);
        } else {
          this.database.prepare('UPDATE shot_groups SET seq = ? WHERE id = ?').run(index + 1, groupId);
        }
        for (const shotId of entry.shotIds) {
          this.database.prepare('UPDATE shots SET group_id = ? WHERE id = ? AND storyboard_script_id = ?').run(groupId, shotId, script.id);
        }
      });
    });
  }

  /** 写入镜头的出场实体与声音；调用前镜头下应没有旧记录。 */
  private replaceRelations(shotId: number, entityIds: readonly number[], sounds: readonly SoundDraft[]): void {
    const insertEntity = this.database.prepare('INSERT INTO shot_entities (shot_id, entity_id) VALUES (?, ?)');
    for (const entityId of entityIds) {
      insertEntity.run(shotId, entityId);
    }
    const insertSound = this.database.prepare(
      `INSERT INTO shot_sounds
         (shot_id, seq, kind, speaker_entity_id, text, delivery, start_offset_seconds, duration_seconds, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    sounds.forEach((sound, index) => {
      insertSound.run(
        shotId,
        index + 1,
        sound.kind,
        sound.speakerEntityId,
        sound.text,
        sound.delivery,
        sound.startOffsetSeconds,
        sound.durationSeconds,
        sound.isEnabled ? 1 : 0
      );
    });
  }
}
