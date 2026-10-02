// ------------------------------------------------------------------------
// 名称：project-service.ts
// 说明：项目应用服务：校验提交内容、检查名称唯一、调用仓库并在变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 和具体存储，时钟可注入以便测试。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError } from '../../domain/errors';
import { Project, ProjectDeletionImpact, ProjectSummary } from '../../domain/models/project';
import { ProjectRepository } from '../../domain/ports/project-repository';
import { normalizeProjectInput } from '../../domain/rules/project-rules';
import { ChangeNotifier } from './change-notifier';

/** 项目名称重复时的错误提示。 */
export const DUPLICATE_PROJECT_NAME_MESSAGE = '已存在同名项目，请换一个名称。';

/** 项目应用服务。 */
export class ProjectService {
  private readonly changeNotifier = new ChangeNotifier();

  /**
   * @param repository 项目仓库。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly repository: ProjectRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅项目数据变化；返回取消订阅的函数。 */
  onDidChangeProjects(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 列出全部项目及其作品数。 */
  listProjects(): ProjectSummary[] {
    return this.repository.listSummaries();
  }

  /** 按标识查找项目；不存在返回 undefined。 */
  findProject(id: number): Project | undefined {
    return this.repository.findById(id);
  }

  /**
   * 读取项目。
   * @throws NotFoundError 项目不存在。
   */
  getProject(id: number): Project {
    const project = this.repository.findById(id);
    if (project === undefined) {
      throw new NotFoundError(`项目 ${id} 不存在。`);
    }
    return project;
  }

  /**
   * 判断名称是否可用，用于表单在字段失去焦点时检查重名。
   * @param name 待检查的名称，会去除首尾空白。
   * @param excludeProjectId 修改项目时排除自身。
   */
  isProjectNameAvailable(name: string, excludeProjectId?: number): boolean {
    const existing = this.repository.findByName(name.trim());
    return existing === undefined || existing.id === excludeProjectId;
  }

  /**
   * 创建项目。
   * @param rawInput 表单提交的原始内容。
   * @throws ValidationError 内容不合法。
   * @throws ConflictError 名称重复。
   */
  createProject(rawInput: unknown): Project {
    const input = normalizeProjectInput(rawInput);
    this.assertNameAvailable(input.name);
    const project = this.repository.insert(input, this.timestamp());
    this.changeNotifier.notify();
    return project;
  }

  /**
   * 修改项目。
   * @param id 项目标识。
   * @param rawInput 表单提交的原始内容。
   * @throws ValidationError 内容不合法。
   * @throws ConflictError 名称与其他项目重复。
   * @throws NotFoundError 项目不存在。
   */
  updateProject(id: number, rawInput: unknown): Project {
    const input = normalizeProjectInput(rawInput);
    this.assertNameAvailable(input.name, id);
    const project = this.repository.update(id, input, this.timestamp());
    if (project === undefined) {
      throw new NotFoundError(`项目 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return project;
  }

  /**
   * 统计删除项目时会一并删除的内容。
   * @throws NotFoundError 项目不存在。
   */
  getDeletionImpact(id: number): ProjectDeletionImpact {
    this.getProject(id);
    return this.repository.countDeletionImpact(id);
  }

  /**
   * 删除项目及其下全部内容。
   * @throws NotFoundError 项目不存在。
   */
  deleteProject(id: number): void {
    if (!this.repository.remove(id)) {
      throw new NotFoundError(`项目 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
  }

  /** 名称已被其他项目占用时抛出冲突错误。 */
  private assertNameAvailable(name: string, excludeProjectId?: number): void {
    if (!this.isProjectNameAvailable(name, excludeProjectId)) {
      throw new ConflictError('name', DUPLICATE_PROJECT_NAME_MESSAGE);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
