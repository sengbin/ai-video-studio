// ------------------------------------------------------------------------
// 名称：sqlite-project-repository.ts
// 说明：项目数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：删除项目依赖外键级联，连接必须已启用外键。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { Project, ProjectDeletionImpact, ProjectInput, ProjectSummary } from '../../domain/models/project';
import { ProjectRepository } from '../../domain/ports/project-repository';

/** projects 表的一行。 */
interface ProjectRow {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly visual_style: string | null;
  readonly default_aspect_ratio: string | null;
  readonly default_resolution: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 带作品数的项目行。 */
interface ProjectSummaryRow extends ProjectRow {
  readonly work_count: number;
}

/** 删除影响统计行。 */
interface DeletionImpactRow {
  readonly work_count: number;
  readonly video_result_count: number;
}

/** 基于 SQLite 的项目仓库。 */
export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: DatabaseSync) {}

  listSummaries(): ProjectSummary[] {
    const rows = this.database
      .prepare(
        `SELECT p.*,
                (SELECT COUNT(*) FROM works w WHERE w.project_id = p.id) AS work_count
           FROM projects p
          ORDER BY p.updated_at DESC, p.id DESC`
      )
      .all() as unknown as ProjectSummaryRow[];
    return rows.map((row) => ({ ...toProject(row), workCount: row.work_count }));
  }

  findById(id: number): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  findByName(name: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE name = ?').get(name) as unknown as
      | ProjectRow
      | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  insert(input: ProjectInput, timestamp: string): Project {
    const result = this.database
      .prepare(
        `INSERT INTO projects (name, description, visual_style, default_aspect_ratio, default_resolution, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.name,
        input.description,
        input.visualStyle,
        input.defaultAspectRatio,
        input.defaultResolution,
        timestamp,
        timestamp
      );
    return this.requireProject(Number(result.lastInsertRowid));
  }

  update(id: number, input: ProjectInput, timestamp: string): Project | undefined {
    const result = this.database
      .prepare(
        `UPDATE projects
            SET name = ?, description = ?, visual_style = ?, default_aspect_ratio = ?, default_resolution = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(input.name, input.description, input.visualStyle, input.defaultAspectRatio, input.defaultResolution, timestamp, id);
    return result.changes === 0 ? undefined : this.requireProject(id);
  }

  remove(id: number): boolean {
    return this.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  countDeletionImpact(id: number): ProjectDeletionImpact {
    const row = this.database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM works WHERE project_id = ?) AS work_count,
                (SELECT COUNT(*)
                   FROM video_results vr
                   JOIN shot_groups g ON g.id = vr.group_id
                   JOIN storyboard_scripts ss ON ss.id = g.storyboard_script_id
                   JOIN episodes e ON e.id = ss.episode_id
                   JOIN works w ON w.id = e.work_id
                  WHERE w.project_id = ?) AS video_result_count`
      )
      .get(id, id) as unknown as DeletionImpactRow;
    return { workCount: row.work_count, videoResultCount: row.video_result_count };
  }

  /** 读取刚写入的项目；读不到说明数据库状态异常，直接报错。 */
  private requireProject(id: number): Project {
    const project = this.findById(id);
    if (project === undefined) {
      throw new Error(`保存项目后无法读取项目 ${id}。`);
    }
    return project;
  }
}

/** 数据库行转领域模型。 */
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visualStyle: row.visual_style,
    defaultAspectRatio: row.default_aspect_ratio,
    defaultResolution: row.default_resolution,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
