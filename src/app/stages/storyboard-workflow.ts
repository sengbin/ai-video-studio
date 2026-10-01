// ------------------------------------------------------------------------
// 名称：storyboard-workflow.ts
// 说明：分镜脚本阶段工作流：依据已确认剧本中的某一集和作品的实体清单，一次调用生成整集的镜头、出场实体与声音。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：产出直接写入分镜脚本、镜头表（不需要合并）；重试时已有产出则跳过；镜头引用的实体按名称映射为实体标识。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { ENTITY_KIND_LABELS } from '../../domain/models/screenplay';
import { SOUND_KIND_LABELS, StoryboardEntity, StoryboardParams } from '../../domain/models/storyboard';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { FieldErrors, assertNoFieldErrors, readOptionalText, readRecord, readText } from '../../domain/rules/field-readers';
import { PROJECT_VISUAL_STYLE_MAX_LENGTH } from '../../domain/rules/project-rules';
import { WORK_NAME_MAX_LENGTH } from '../../domain/rules/work-rules';
import { MAX_SHOTS_LIMIT, normalizeStoryboardParams, parseStoryboard } from '../../domain/rules/storyboard-rules';
import { askModel } from './ask-model';
import { createStoryboardTool } from './output-tools/storyboard-output-tools';
import { wrapMaterial } from './prompt-templates';
import { StageContext, StageWorkflow } from './stage-workflow';

/** 分镜脚本阶段保存到阶段记录的输入快照。 */
export interface StoryboardRunInput {
  readonly workName: string;
  /** 生成时项目的视觉风格；本次没有自定义风格时沿用它。 */
  readonly projectStyle: string | null;
  readonly params: StoryboardParams;
}

/** 分镜脚本工作流的依赖。 */
export interface StoryboardWorkflowDependencies {
  readonly screenplays: ScreenplayRepository;
  readonly storyboards: StoryboardRepository;
  readonly prompts: PromptTemplates;
  readonly now?: () => Date;
}

/** 提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const STORYBOARD_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  storyboard: ['material', 'entities', 'style', 'shotRules', 'continuityRule', 'audioRule', 'extra']
};

const NOT_APPLICABLE = '（无）';
const NO_STYLE = '（没有指定，按剧情自行确定一种统一的画面风格，并在各镜头中保持一致）';

/** 镜头数量与时长的要求。 */
function describeShotRules(params: StoryboardParams): string {
  const limit = params.maxShots ?? MAX_SHOTS_LIMIT;
  const parts = [`镜头总数不超过 ${limit} 个，按剧情需要决定数量，不要为凑数拆分。`];
  if (params.minShotSeconds !== null || params.maxShotSeconds !== null) {
    const min = params.minShotSeconds === null ? '' : `不少于 ${params.minShotSeconds} 秒`;
    const max = params.maxShotSeconds === null ? '' : `不超过 ${params.maxShotSeconds} 秒`;
    parts.push(`每个镜头时长${[min, max].filter((part) => part.length > 0).join('、')}。`);
  }
  return parts.join('');
}

/** 镜头连贯的要求。 */
function describeContinuity(params: StoryboardParams): string {
  switch (params.continuity) {
    case 'none':
      return '镜头之间不要求画面衔接，不需要指定首帧。';
    case 'prev_tail':
      return '每个镜头（第 1 个除外）都以上一镜头的尾帧作为首帧，因此相邻镜头的画面、人物位置和光线必须能自然衔接。';
    case 'ai':
      return '逐个镜头判断 firstFrameMode：画面与上一镜头连续（同一场景、同一时间、人物位置自然延续）时填 prev_tail，场景或时间切换时填 none；第 1 个镜头只能填 none。';
  }
}

/** 声音的要求。 */
function describeAudio(params: StoryboardParams): string {
  if (params.audioMode === 'none') {
    return '这是无声视频，不要生成任何声音条目。';
  }
  const kinds = params.audioElements.map((kind) => `${kind}（${SOUND_KIND_LABELS[kind]}）`).join('、');
  const dialogue = params.audioElements.includes('dialogue')
    ? '角色对白必须填写 speaker（已有的角色名称），台词取自剧本，可适当精简但不得改变原意。'
    : '';
  return `只生成这些类型的声音条目：${kinds}。声音按出现顺序排列，没有声音的镜头给空数组。${dialogue}`;
}

/** 实体清单：每行一个实体，含别名与设定摘要。 */
function describeEntities(entities: readonly StoryboardEntity[], descriptions: ReadonlyMap<number, string>): string {
  if (entities.length === 0) {
    return NOT_APPLICABLE;
  }
  return entities
    .map((entity) => {
      const aliases = entity.aliases.length === 0 ? '' : `（别名：${entity.aliases.join('、')}）`;
      const description = descriptions.get(entity.id);
      return `- ${ENTITY_KIND_LABELS[entity.kind]}：${entity.name}${aliases}${description === undefined || description === '' ? '' : `——${description}`}`;
    })
    .join('\n');
}

/** 分镜脚本阶段工作流。 */
export class StoryboardWorkflow implements StageWorkflow {
  readonly stage = 'storyboard_script' as const;

  constructor(private readonly dependencies: StoryboardWorkflowDependencies) {}

  normalizeInput(rawInput: unknown): Readonly<Record<string, unknown>> {
    const source = readRecord(rawInput);
    const errors: FieldErrors = {};
    const workName = readText(source, { key: 'workName', label: '作品名称', required: true, maxLength: WORK_NAME_MAX_LENGTH }, errors);
    const projectStyle = readOptionalText(
      source,
      { key: 'projectStyle', label: '项目视觉风格', required: false, maxLength: PROJECT_VISUAL_STYLE_MAX_LENGTH },
      errors
    );
    assertNoFieldErrors(errors);
    const params = normalizeStoryboardParams(typeof source.params === 'object' && source.params !== null ? source.params : source);
    return { workName, projectStyle, params };
  }

  async execute(context: StageContext): Promise<void> {
    const { run } = context;
    const { screenplays, storyboards, prompts } = this.dependencies;
    // 输入快照由 normalizeInput 生成，结构可信。
    const input = run.input as unknown as StoryboardRunInput;
    const { params } = input;
    if (run.episodeId === null) {
      throw new Error(`阶段记录 ${run.id} 缺少集标识。`);
    }
    if (storyboards.find(run.id) !== undefined) {
      return;
    }

    const episode = screenplays.listEpisodes(run.workId).find((candidate) => candidate.id === run.episodeId);
    if (episode === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有找到这一集，请先确认剧本。' });
    }
    const records = screenplays.listEntities(run.workId).filter((entity) => entity.isActive);
    const entities: StoryboardEntity[] = records.map(({ id, kind, name, aliases }) => ({ id, kind, name, aliases }));
    const descriptions = new Map(records.map((entity) => [entity.id, entity.description]));

    context.reportProgress({ step: '生成分镜脚本', total: 1, done: 0 });
    const shots = await askModel(
      context,
      prompts,
      'storyboard',
      {
        material: wrapMaterial(`【第 ${episode.seq} 集 ${episode.title}】\n梗概：${episode.synopsis}\n\n${episode.screenplayText}`),
        entities: describeEntities(entities, descriptions),
        style: params.visualStyle ?? input.projectStyle ?? NO_STYLE,
        shotRules: describeShotRules(params),
        continuityRule: describeContinuity(params),
        audioRule: describeAudio(params),
        extra: params.extra ?? NOT_APPLICABLE
      },
      (json) => parseStoryboard(json, { params, entities }),
      { overflowHint: '本集剧本过长，请在剧本阶段把这一集拆短后重新生成。', tool: createStoryboardTool(params) }
    );
    storyboards.save(run.id, run.episodeId, shots, (this.dependencies.now?.() ?? new Date()).toISOString());
  }
}
