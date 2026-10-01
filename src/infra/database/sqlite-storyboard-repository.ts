// ------------------------------------------------------------------------
// 名称：sqlite-storyboard-repository.ts
// 说明：分镜脚本、镜头、镜头出场实体与镜头声音数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：整份保存与单个镜头修改都在事务内完成，不能在已有事务中调用。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { FirstFrameMode, ShotDraft, ShotEdit, ShotRecord, SoundDraft, SoundKind, SoundRecord, StoryboardScript } from '../../domain/models/storyboard';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { runInTransaction } from './transaction';

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
