// ------------------------------------------------------------------------
// 名称：asset-service.ts
// 说明：资产应用服务：校验提交内容、检查名称唯一、调用仓库保存资产与文件，并在变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code 和具体存储；所属项目在表单里以项目名称选择（项目名称全局唯一）；创建后不能修改所属项目与类型。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetFileRecord, AssetKind, AssetListItem, AssetRecord, AssetUsageSummary } from '../../domain/models/asset';
import { ProjectSummary } from '../../domain/models/project';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { normalizeAssetContent } from '../../domain/rules/asset-rules';
import { FieldErrors, readRecord } from '../../domain/rules/field-readers';
import { ChangeNotifier } from './change-notifier';
import { ProjectService } from './project-service';

/** 同项目、同类型下资产重名时的提示。 */
export const DUPLICATE_ASSET_NAME_MESSAGE = '该项目下已有同名资产，请换一个名称。';

/** 所属项目字段的键：值为项目名称。 */
export const ASSET_PROJECT_FIELD_KEY = 'projectName';

const PROJECT_REQUIRED_MESSAGE = '请选择所属项目。';
const AUDIO_KIND_LOCKED_MESSAGE = '该音频已被绑定或引用，不能修改音频类型。';

/** 创建资产时的可选来源：由哪个脚本实体创建。 */
export interface CreateAssetOptions {
  readonly sourceEntityId?: number;
}

/** 删除资产前需要告知用户的信息。 */
export interface AssetDeletionImpact {
  readonly name: string;
  readonly usage: AssetUsageSummary;
}

/** 资产应用服务。 */
export class AssetService {
  private readonly changeNotifier = new ChangeNotifier();

  /**
   * @param repository 资产仓库。
   * @param projects 项目服务，用于按名称确定所属项目。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly repository: AssetRepository,
    private readonly projects: ProjectService,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅资产数据变化；返回取消订阅的函数。 */
  onDidChangeAssets(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 列出某类型全部项目的资产，按更新时间倒序。 */
  listAssets(kind: AssetKind): AssetListItem[] {
    return this.repository.list(kind);
  }

  /**
   * 读取资产。
   * @throws NotFoundError 资产不存在。
   */
  getAsset(id: number): AssetRecord {
    const asset = this.repository.findById(id);
    if (asset === undefined) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    return asset;
  }

  /** 读取资产的参考文件（含内容），用于编辑表单带出已有文件。 */
  getReferenceFiles(id: number): AssetFileRecord[] {
    return this.repository.listReferenceFiles(this.getAsset(id).id);
  }

  /**
   * 判断名称在项目内（同类型）是否可用，用于表单在字段失去焦点时检查重名。
   * @param excludeAssetId 修改资产时排除自身。
   */
  isNameAvailable(projectId: number, kind: AssetKind, name: string, excludeAssetId?: number): boolean {
    const existing = this.repository.findByName(projectId, kind, name.trim());
    return existing === undefined || existing.id === excludeAssetId;
  }

  /**
   * 创建资产。
   * @param kind 资产类型。
   * @param rawInput 表单提交的原始内容，含所属项目名称。
   * @throws ValidationError 内容不合法或没有选择项目。
   * @throws ConflictError 同项目、同类型下名称重复。
   */
  createAsset(kind: AssetKind, rawInput: unknown, options: CreateAssetOptions = {}): AssetRecord {
    const source = readRecord(rawInput);
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, kind, errors);
    const project = findProject(this.projects.listProjects(), source[ASSET_PROJECT_FIELD_KEY], errors);
    if (Object.keys(errors).length > 0 || normalized === undefined || project === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(project.id, kind, normalized.content.name);
    const id = this.repository.insert(
      { ...normalized.content, projectId: project.id, kind, sourceEntityId: options.sourceEntityId ?? null },
      normalized.files,
      this.timestamp()
    );
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 修改资产的内容并整体替换参考文件；所属项目与类型不能修改。
   * @throws ValidationError 内容不合法，或已被使用的音频修改了音频类型。
   * @throws ConflictError 名称与同项目同类型的其他资产重复。
   * @throws NotFoundError 资产不存在。
   */
  updateAsset(id: number, rawInput: unknown): AssetRecord {
    const asset = this.getAsset(id);
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, asset.kind, errors);
    if (Object.keys(errors).length > 0 || normalized === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(asset.projectId, asset.kind, normalized.content.name, id);
    if (asset.kind === 'audio' && normalized.content.attributes.audio_kind !== asset.attributes.audio_kind && this.isInUse(id)) {
      throw new ValidationError({ audioKind: AUDIO_KIND_LOCKED_MESSAGE });
    }
    if (!this.repository.update(id, normalized.content, normalized.files, this.timestamp())) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 读取删除资产前需要告知用户的名称与使用情况。
   * @throws NotFoundError 资产不存在。
   */
  getDeletionImpact(id: number): AssetDeletionImpact {
    const asset = this.getAsset(id);
    return { name: asset.name, usage: this.repository.getUsage(id) };
  }

  /**
   * 删除资产及其文件和绑定。
   * @throws NotFoundError 资产不存在。
   */
  deleteAsset(id: number): void {
    if (!this.repository.remove(id)) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
  }

  /** 资产是否已被绑定或被镜头声音指定。 */
  private isInUse(id: number): boolean {
    const usage = this.repository.getUsage(id);
    return usage.bindings.length > 0 || usage.soundReferences > 0;
  }

  /** 校验资产内容；内容错误累积到 errors，不抛出，便于和项目错误一并返回。 */
  private tryNormalize(rawInput: unknown, kind: AssetKind, errors: FieldErrors): ReturnType<typeof normalizeAssetContent> | undefined {
    try {
      return normalizeAssetContent(rawInput, kind);
    } catch (error) {
      if (error instanceof ValidationError) {
        Object.assign(errors, error.fieldErrors);
        return undefined;
      }
      throw error;
    }
  }

  private assertNameAvailable(projectId: number, kind: AssetKind, name: string, excludeAssetId?: number): void {
    if (!this.isNameAvailable(projectId, kind, name, excludeAssetId)) {
      throw new ConflictError('name', DUPLICATE_ASSET_NAME_MESSAGE);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** 按项目名称找到所选项目；没有选择或项目已不存在时记录字段错误。 */
function findProject(projects: readonly ProjectSummary[], name: unknown, errors: FieldErrors): ProjectSummary | undefined {
  const project = typeof name === 'string' ? projects.find((item) => item.name === name.trim()) : undefined;
  if (project === undefined) {
    errors[ASSET_PROJECT_FIELD_KEY] = PROJECT_REQUIRED_MESSAGE;
  }
  return project;
}
