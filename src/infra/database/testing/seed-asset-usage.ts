// ------------------------------------------------------------------------
// 名称：seed-asset-usage.ts
// 说明：资产使用情况相关测试共用的种子数据：一个作品下的若干集与角色，并可按需写入实体绑定和镜头声音对音频资产的引用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除；直接用 SQL 写入，不经过服务层；项目由调用方先创建。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';

/** 种子数据的标识与写入方法。 */
export interface AssetUsageSeed {
  readonly workId: number;
  /** 各集标识，按集序号排列（第 1 集、第 2 集……）。 */
  readonly episodeIds: readonly number[];
  /** 作品下的角色实体标识：林夏、周远。 */
  readonly entityIds: readonly number[];
  /**
   * 写入一条实体与资产的绑定。
   * @param episodeIndex 集在 episodeIds 中的下标。
   * @param entityIndex 角色在 entityIds 中的下标。
   */
  bindEntity(assetId: number, episodeIndex: number, entityIndex: number, purpose: 'visual' | 'voice'): void;
  /**
   * 在某集的分镜里写入若干条指定了音频资产的镜头声音。
   * @param count 条数，缺省为 1。
   */
  addSounds(assetId: number, episodeIndex: number, count?: number): void;
}

/**
 * 写入一个作品、若干集和两个角色。
 * @param database 内存数据库。
 * @param projectId 作品所属项目。
 * @param episodeCount 集数，缺省为 2。
 */
export function seedAssetUsage(database: DatabaseSync, projectId: number, episodeCount = 2): AssetUsageSeed {
  const insert = (sql: string, ...params: Array<string | number>): number => Number(database.prepare(sql).run(...params).lastInsertRowid);
  const workId = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'series', 't', 't')", projectId);
  const episodeIds = Array.from({ length: episodeCount }, (_, index) =>
    insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, ?, ?, 't', 't')", workId, index + 1, `第${index + 1}集标题`)
  );
  const entityIds = ['林夏', '周远'].map((name) =>
    insert("INSERT INTO script_entities (work_id, kind, name, created_at, updated_at) VALUES (?, 'character', ?, 't', 't')", workId, name)
  );
  /** 每集的第一个镜头：第一次写入声音时才创建，之后复用。 */
  const shotOfEpisode = new Map<number, number>();
  const soundCountOfShot = new Map<number, number>();

  const shotFor = (episodeId: number): number => {
    const existing = shotOfEpisode.get(episodeId);
    if (existing !== undefined) {
      return existing;
    }
    const runId = insert(
      "INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, status, review_status, is_current, created_at) VALUES (?, ?, 'storyboard_script', 1, '{}', 'succeeded', 'approved', 1, 't')",
      workId,
      episodeId
    );
    const scriptId = insert("INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (?, ?, 't')", episodeId, runId);
    const shotId = insert(
      "INSERT INTO shots (storyboard_script_id, seq, action, duration_seconds, created_at, updated_at) VALUES (?, 1, '远景', 4, 't', 't')",
      scriptId
    );
    shotOfEpisode.set(episodeId, shotId);
    return shotId;
  };

  return {
    workId,
    episodeIds,
    entityIds,
    bindEntity: (assetId, episodeIndex, entityIndex, purpose) => {
      insert(
        "INSERT INTO entity_bindings (episode_id, entity_id, asset_id, purpose, created_at) VALUES (?, ?, ?, ?, 't')",
        episodeIds[episodeIndex],
        entityIds[entityIndex],
        assetId,
        purpose
      );
    },
    addSounds: (assetId, episodeIndex, count = 1) => {
      const shotId = shotFor(episodeIds[episodeIndex]);
      for (let index = 0; index < count; index += 1) {
        const seq = (soundCountOfShot.get(shotId) ?? 0) + 1;
        soundCountOfShot.set(shotId, seq);
        insert("INSERT INTO shot_sounds (shot_id, seq, kind, text, audio_asset_id) VALUES (?, ?, 'music', '配乐', ?)", shotId, seq, assetId);
      }
    }
  };
}
