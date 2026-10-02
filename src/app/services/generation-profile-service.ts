// ------------------------------------------------------------------------
// 名称：generation-profile-service.ts
// 说明：生成参数应用服务：读取一集的作品级与集级参数及合并后的生效值，保存某一级的修改（含恢复继承）；也可直接读取、保存作品默认（供分镜脚本表单使用）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；只保存参数值，不校验是否落在所选模型的能力范围内（由界面标红、提交时校验）；模型必须存在且是视频模型。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { EMPTY_PROFILE, EffectiveProfile, ProfileScope, ProfileTarget, ProfileValues } from '../../domain/models/generation-profile';
import { GenerationProfileRepository } from '../../domain/ports/generation-profile-repository';
import { ProviderRepository } from '../../domain/ports/provider-repository';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { ProfileChanges, applyProfileChanges, assertChangesAllowedInScope, readProfileChanges, resolveProfile } from '../../domain/rules/generation-profile-rules';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { ChangeNotifier } from './change-notifier';
import { ProjectService } from './project-service';
import { WorkService } from './work-service';

/** 一集的生成参数视图：两级保存的值与合并后的生效值。 */
export interface EpisodeProfileView {
  readonly workId: number;
  readonly episodeId: number;
  /** 作品默认（本作品所有集共用）。 */
  readonly work: ProfileValues;
  /** 本集覆盖。 */
  readonly episode: ProfileValues;
  readonly effective: EffectiveProfile;
}

/** 生成参数应用服务的依赖。 */
export interface GenerationProfileServiceDependencies {
  readonly profiles: GenerationProfileRepository;
  readonly works: WorkService;
  readonly projects: ProjectService;
  readonly screenplays: Pick<ScreenplayRepository, 'listEpisodes'>;
  readonly models: Pick<ProviderRepository, 'findModelById'>;
  readonly now?: () => Date;
}

/** 生成参数应用服务。 */
export class GenerationProfileService {
  private readonly changeNotifier = new ChangeNotifier();

  constructor(private readonly dependencies: GenerationProfileServiceDependencies) {}

  /** 订阅参数变化；返回取消订阅的函数。 */
  onDidChangeProfiles(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /**
   * 读取一集的生成参数视图。
   * @throws NotFoundError 作品不存在，或集不属于该作品。
   */
  getView(workId: number, episodeId: number): EpisodeProfileView {
    const work = this.dependencies.works.getWork(workId);
    this.assertEpisodeBelongs(workId, episodeId);
    const { profiles, projects } = this.dependencies;
    const workValues = profiles.find({ scope: 'work', workId }) ?? EMPTY_PROFILE;
    const episodeValues = profiles.find({ scope: 'episode', episodeId }) ?? EMPTY_PROFILE;
    const project = projects.getProject(work.projectId);
    return {
      workId,
      episodeId,
      work: workValues,
      episode: episodeValues,
      effective: resolveProfile(workValues, episodeValues, { aspectRatio: project.defaultAspectRatio, resolution: project.defaultResolution })
    };
  }

  /**
   * 保存某一级的参数修改：changes 里出现的字段被覆盖，值为 null（或空串）表示恢复继承。
   * @param rawInput `{ scope: 'work' | 'episode', workId, episodeId, changes }`。
   * @returns 保存后的参数视图。
   * @throws ValidationError 范围、字段或值不合法（含在作品、集范围设置只能按镜头组设置的生成时长），或模型不是可用的视频模型。
   * @throws NotFoundError 作品或集不存在。
   */
  save(rawInput: unknown): EpisodeProfileView {
    const source = readRecord(rawInput);
    const scope = readScope(source.scope);
    const workId = readEntityId({ id: source.workId }, '作品');
    const episodeId = readEntityId({ id: source.episodeId }, '集');
    const changes = readProfileChanges(source.changes);
    this.dependencies.works.getWork(workId);
    this.assertEpisodeBelongs(workId, episodeId);
    this.saveChanges(scope === 'work' ? { scope, workId } : { scope, episodeId }, changes);
    return this.getView(workId, episodeId);
  }

  /**
   * 读取作品默认参数的生效值：作品默认优先，画幅与分辨率回退到项目默认；不含各集的覆盖。
   * @throws NotFoundError 作品不存在。
   */
  getWorkDefaults(workId: number): EffectiveProfile {
    const work = this.dependencies.works.getWork(workId);
    const project = this.dependencies.projects.getProject(work.projectId);
    const workValues = this.dependencies.profiles.find({ scope: 'work', workId }) ?? EMPTY_PROFILE;
    return resolveProfile(workValues, EMPTY_PROFILE, { aspectRatio: project.defaultAspectRatio, resolution: project.defaultResolution });
  }

  /**
   * 保存作品默认参数的修改，规则与 save 的作品级相同。
   * @param workId 作品标识。
   * @param changes 要修改的字段；值为 null 表示恢复继承，没有出现的字段不变。
   * @throws ValidationError 没有要修改的字段，或模型不是可用的视频模型。
   * @throws NotFoundError 作品不存在。
   */
  saveWorkDefaults(workId: number, changes: ProfileChanges): void {
    this.dependencies.works.getWork(workId);
    this.saveChanges({ scope: 'work', workId }, readProfileChanges(changes));
  }

  /** 校验范围与模型后把修改合并到该范围已保存的值并通知变化。 */
  private saveChanges(target: ProfileTarget, changes: ProfileChanges): void {
    assertChangesAllowedInScope(target.scope, changes);
    if (changes.modelId !== undefined && changes.modelId !== null) {
      const model = this.dependencies.models.findModelById(changes.modelId);
      if (model === undefined || model.kind !== 'video') {
        throw new ValidationError({ modelId: '所选模型不存在或不是视频模型。' });
      }
    }
    const current = this.dependencies.profiles.find(target) ?? EMPTY_PROFILE;
    this.dependencies.profiles.save(target, applyProfileChanges(current, changes), (this.dependencies.now?.() ?? new Date()).toISOString());
    this.changeNotifier.notify();
  }

  private assertEpisodeBelongs(workId: number, episodeId: number): void {
    if (!this.dependencies.screenplays.listEpisodes(workId).some((episode) => episode.id === episodeId)) {
      throw new NotFoundError('集不存在。');
    }
  }
}

/** 读取参数范围。 */
function readScope(value: unknown): Extract<ProfileScope, 'work' | 'episode'> {
  if (value !== 'work' && value !== 'episode') {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '参数范围必须是作品或集。' });
  }
  return value;
}
