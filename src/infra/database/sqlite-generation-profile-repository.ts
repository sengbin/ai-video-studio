// ------------------------------------------------------------------------
// 名称：sqlite-generation-profile-repository.ts
// 说明：生成参数（作品级、集级）的 SQLite 数据访问：读取与保存模型、画幅、分辨率、声音模式。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：每个目标一行（部分唯一索引）；保存只改这四个字段，表里其他预留字段保持不变；作品、集删除时随外键级联清除。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ProfileTarget, ProfileValues } from '../../domain/models/generation-profile';
import { VideoAudioMode } from '../../domain/models/model-capability';
import { GenerationProfileRepository } from '../../domain/ports/generation-profile-repository';
import { runInTransaction } from './transaction';

/** generation_profiles 表中本仓库使用的列。 */
interface ProfileRow {
  readonly model_id: number | null;
  readonly aspect_ratio: string | null;
  readonly resolution: string | null;
  readonly audio_mode: VideoAudioMode | null;
}

/** 目标对应的过滤条件、参数与保存时写入的外键列。 */
function targetFilter(target: ProfileTarget): { readonly where: string; readonly id: number; readonly column: string } {
  switch (target.scope) {
    case 'work':
      return { where: "scope = 'work' AND work_id = ?", id: target.workId, column: 'work_id' };
    case 'episode':
      return { where: "scope = 'episode' AND episode_id = ?", id: target.episodeId, column: 'episode_id' };
    case 'group':
      return { where: "scope = 'group' AND group_id = ?", id: target.groupId, column: 'group_id' };
  }
}

/** 数据库行转为参数值。 */
function toValues(row: ProfileRow): ProfileValues {
  return { modelId: row.model_id, aspectRatio: row.aspect_ratio, resolution: row.resolution, audioMode: row.audio_mode };
}

/** 基于 SQLite 的生成参数仓库。 */
export class SqliteGenerationProfileRepository implements GenerationProfileRepository {
  constructor(private readonly database: DatabaseSync) {}

  find(target: ProfileTarget): ProfileValues | undefined {
    const { where, id } = targetFilter(target);
    const row = this.database
      .prepare(`SELECT model_id, aspect_ratio, resolution, audio_mode FROM generation_profiles WHERE ${where}`)
      .get(id) as unknown as ProfileRow | undefined;
    return row === undefined ? undefined : toValues(row);
  }

  listByGroups(groupIds: readonly number[]): ReadonlyMap<number, ProfileValues> {
    if (groupIds.length === 0) {
      return new Map();
    }
    const rows = this.database
      .prepare(
        `SELECT group_id, model_id, aspect_ratio, resolution, audio_mode FROM generation_profiles
         WHERE scope = 'group' AND group_id IN (${groupIds.map(() => '?').join(', ')})`
      )
      .all(...groupIds) as unknown as Array<ProfileRow & { readonly group_id: number }>;
    return new Map(rows.map((row) => [row.group_id, toValues(row)]));
  }

  save(target: ProfileTarget, values: ProfileValues, timestamp: string): void {
    const { where, id, column } = targetFilter(target);
    runInTransaction(this.database, () => {
      const updated = this.database
        .prepare(`UPDATE generation_profiles SET model_id = ?, aspect_ratio = ?, resolution = ?, audio_mode = ?, updated_at = ? WHERE ${where}`)
        .run(values.modelId, values.aspectRatio, values.resolution, values.audioMode, timestamp, id);
      if (Number(updated.changes) > 0) {
        return;
      }
      this.database
        .prepare(
          `INSERT INTO generation_profiles (scope, ${column}, model_id, aspect_ratio, resolution, audio_mode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(target.scope, id, values.modelId, values.aspectRatio, values.resolution, values.audioMode, timestamp);
    });
  }
}
