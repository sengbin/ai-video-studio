// ------------------------------------------------------------------------
// 名称：recent-project-store.ts
// 说明：最近使用的项目：记录用户最近一次打开的项目，供侧栏的创作入口直接落到该项目。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：保存在扩展的全局状态中（vscode.Memento 满足这里的键值接口）；记录的项目已被删除时视为没有最近项目。
// ------------------------------------------------------------------------

import { Project } from '../../domain/models/project';

/** 最小的键值存储接口，vscode.Memento 满足它。 */
export interface KeyValueState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** 全局状态中保存最近项目标识的键。 */
export const RECENT_PROJECT_STATE_KEY = 'aiVideoStudio.recentProjectId';

/** 最近使用的项目。 */
export class RecentProjectStore {
  /**
   * @param state 键值存储。
   * @param findProject 按标识查找项目，找不到返回 undefined，用于判断记录是否仍然有效。
   */
  constructor(
    private readonly state: KeyValueState,
    private readonly findProject: (id: number) => Project | undefined
  ) {}

  /** 读取最近使用的项目；没有记录或项目已被删除时返回 undefined，并清除失效的记录。 */
  get(): Project | undefined {
    const id = this.state.get<unknown>(RECENT_PROJECT_STATE_KEY);
    if (typeof id !== 'number') {
      return undefined;
    }
    const project = this.findProject(id);
    if (project === undefined) {
      void this.state.update(RECENT_PROJECT_STATE_KEY, undefined);
    }
    return project;
  }

  /** 记录最近使用的项目。 */
  set(projectId: number): void {
    void this.state.update(RECENT_PROJECT_STATE_KEY, projectId);
  }
}
