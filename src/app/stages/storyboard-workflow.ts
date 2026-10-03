// ------------------------------------------------------------------------
// 名称：storyboard-workflow.ts
// 说明：分镜脚本阶段工作流：依据已确认剧本中的某一集和作品的实体清单，生成整集的镜头、出场实体与声音；正文较长且有多个“第N场”标题时按场次分批，逐批调用模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：产出直接写入分镜脚本、镜头表（不需要合并）；全部批次成功后才一次写入，重试时已有产出则跳过、否则从第一批重做；镜头引用的实体按名称映射为实体标识；目标画幅写入输入快照并按横屏、竖屏提示构图；分批时镜头数与时长预算按各批正文占比分配，序号连续、后一批接着前一批的最后一个镜头。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { ENTITY_KIND_LABELS } from '../../domain/models/screenplay';
import { SOUND_KIND_LABELS, ShotDraft, StoryboardEntity, StoryboardParams } from '../../domain/models/storyboard';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { FieldErrors, assertNoFieldErrors, readOptionalText, readRecord, readText } from '../../domain/rules/field-readers';
import { PROJECT_VISUAL_STYLE_MAX_LENGTH } from '../../domain/rules/project-rules';
import { WORK_NAME_MAX_LENGTH } from '../../domain/rules/work-rules';
import { SceneBatch, planSceneBatches } from '../../domain/rules/scene-batching';
import { MAX_SHOTS_LIMIT, normalizeStoryboardParams, parseStoryboard } from '../../domain/rules/storyboard-rules';
import { groupMaxSecondsOf, sumSeconds } from '../../domain/rules/shot-group-rules';
import { syncShotGroups } from '../services/shot-grouping';
import { askModel } from './ask-model';
import { createStoryboardTool } from './output-tools/storyboard-output-tools';
import { wrapMaterial } from './prompt-templates';
import { StageContext, StageWorkflow } from './stage-workflow';

/** 分镜脚本阶段保存到阶段记录的输入快照。 */
export interface StoryboardRunInput {
  readonly workName: string;
  /** 生成时项目的视觉风格；本次没有自定义风格时沿用它。 */
  readonly projectStyle: string | null;
  /** 目标视频画幅（如 16:9）；null 表示没有指定，由模型按常规构图。旧记录没有该字段时也为 null。 */
  readonly aspectRatio: string | null;
  readonly params: StoryboardParams;
}

/** 分镜脚本工作流的依赖。 */
export interface StoryboardWorkflowDependencies {
  readonly screenplays: ScreenplayRepository;
  readonly storyboards: StoryboardRepository;
  readonly prompts: PromptTemplates;
  /** 单批剧本正文的字数上限，缺省为 SCENE_BATCH_MAX_CHARS；超过且识别出多个场次时按场次分批生成。 */
  readonly sceneBatchMaxChars?: number;
  readonly now?: () => Date;
}

/** 提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const STORYBOARD_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  storyboard: ['material', 'entities', 'style', 'aspectRatio', 'shotRules', 'continuityRule', 'audioRule', 'extra']
};

const NOT_APPLICABLE = '（无）';
const NO_STYLE = '（没有指定，按剧情自行确定一种统一的画面风格，并在各镜头中保持一致）';
const NO_ASPECT_RATIO = '（没有指定，按常见视频的横屏构图处理）';
/** 画幅文本的最大长度，与生成参数里的画幅一致。 */
const ASPECT_RATIO_MAX_LENGTH = 20;
const ASPECT_RATIO_PATTERN = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/;

/**
 * 镜头数量与时长的要求。
 * @param params 生成参数；分批时 maxShots 是本批的镜头数上限。
 * @param totalSeconds 全部镜头总时长的上限：整集生成时是本集目标时长，分批时是本批的时长预算；null 表示不限制。
 * @param isBatch 是否为分批生成的一批，决定措辞。
 */
function describeShotRules(params: StoryboardParams, totalSeconds: number | null, isBatch: boolean): string {
  const limit = params.maxShots ?? MAX_SHOTS_LIMIT;
  const scope = isBatch ? '本批' : '';
  const parts = [`${scope}镜头总数不超过 ${limit} 个，按剧情需要决定数量，不要为凑数拆分。`];
  if (totalSeconds !== null) {
    const budget = isBatch ? `本批的时长预算为 ${totalSeconds} 秒（来自本集目标时长，按剧本篇幅分给各批）` : `本集目标时长为 ${totalSeconds} 秒`;
    parts.push(
      `${budget}，所有镜头的时长之和不得超过 ${totalSeconds} 秒，这是上限而不是必须达到的目标；剧情内容少时镜头数量和总时长都应相应减少，不得为凑时长而增加镜头、拉长镜头或添加剧本没有的情节。`
    );
  }
  if (params.minShotSeconds !== null || params.maxShotSeconds !== null) {
    const min = params.minShotSeconds === null ? '' : `不少于 ${params.minShotSeconds} 秒`;
    const max = params.maxShotSeconds === null ? '' : `不超过 ${params.maxShotSeconds} 秒`;
    parts.push(`每个镜头时长${[min, max].filter((part) => part.length > 0).join('、')}。`);
  }
  const groupMax = groupMaxSecondsOf(params);
  parts.push(
    `相邻镜头会按顺序合并成组，一组一次生成一个视频，每组总时长不超过 ${groupMax} 秒，因此单个镜头不能超过 ${groupMax} 秒；建议每个镜头 4 到 6 秒，同一场次的镜头尽量连续排列。`
  );
  return parts.join('');
}

/** 画幅的要求：说明目标画幅，并按横屏、竖屏、方形给出构图提示；无法解析宽高比时只说明画幅。 */
export function describeAspectRatio(aspectRatio: string | null): string {
  if (aspectRatio === null) {
    return NO_ASPECT_RATIO;
  }
  const matched = ASPECT_RATIO_PATTERN.exec(aspectRatio);
  const width = matched === null ? 0 : Number(matched[1]);
  const height = matched === null ? 0 : Number(matched[2]);
  const lead = `目标视频画幅为 ${aspectRatio}。`;
  if (width <= 0 || height <= 0) {
    return `${lead}按这个画幅安排构图。`;
  }
  if (width > height) {
    return `${lead}这是横屏画面，可以使用横向的宽幅构图和左右方向的人物调度，景别按需要自由选择。`;
  }
  if (width < height) {
    return `${lead}这是竖屏画面，构图以纵向层次为主，主体居中偏上，景别以中景、近景和特写为主，避免依赖左右宽幅的横向调度。`;
  }
  return `${lead}这是方形画面，主体居中，构图紧凑，左右与上下留白均衡。`;
}

/** 镜头连贯的要求；continuesFromPrevious 为 true 表示这一批接在前面已生成的镜头之后。 */
function describeContinuity(params: StoryboardParams, continuesFromPrevious: boolean): string {
  switch (params.continuity) {
    case 'none':
      return '镜头之间不要求画面衔接，不需要指定首帧。';
    case 'prev_tail':
      return continuesFromPrevious
        ? '每个镜头（包括本批第 1 个，它接前面已生成的最后一个镜头）都以上一镜头的尾帧作为首帧，因此相邻镜头的画面、人物位置和光线必须能自然衔接。'
        : '每个镜头（第 1 个除外）都以上一镜头的尾帧作为首帧，因此相邻镜头的画面、人物位置和光线必须能自然衔接。';
    case 'ai':
      return `逐个镜头判断 firstFrameMode：画面与上一镜头连续（同一场景、同一时间、人物位置自然延续）时填 prev_tail，场景或时间切换时填 none；${
        continuesFromPrevious ? '本批第 1 个镜头的上一镜头是前面已生成的最后一个镜头，同样按此判断。' : '第 1 个镜头只能填 none。'
      }`;
  }
}

/** 声音的要求。 */
function describeAudio(params: StoryboardParams): string {
  if (params.audioMode === 'none') {
    return '这是无声视频，不要生成任何声音条目。';
  }
  const kinds = params.audioElements.map((kind) => `${kind}（${SOUND_KIND_LABELS[kind]}）`).join('、');
  const narrationRule = params.audioElements.includes('narration') ? '旁白（narration）只用于不属于任何角色的画外解说。' : '';
  const dialogue = params.audioElements.includes('dialogue')
    ? `任何角色（包括动物、拟人角色）说出的话，包括剧本里写成“角色名（语气）：台词”的每一行，都必须用 dialogue 并填写 speaker（已有的角色名称），语气和说话方式填在 delivery；${narrationRule}台词取自剧本，可适当精简但不得改变原意。`
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

/** 向下取整到一位小数，预算只能少不能多。 */
function roundDown(value: number): number {
  return Math.max(0, Math.floor(value * 10 + 1e-6) / 10);
}

/** 本批的说明：第几批、覆盖的场次、只生成本批内容，以及前面最后一个镜头（接续时参考）。 */
function describeBatch(batch: SceneBatch, index: number, count: number, previous: ShotDraft | undefined): string {
  const range = batch.firstHeading === '' ? '' : batch.firstHeading === batch.lastHeading ? `，场次：${batch.firstHeading}` : `，场次：${batch.firstHeading} 至 ${batch.lastHeading}`;
  const lines = [
    `本集剧本较长，按场次分 ${count} 批生成镜头，这是第 ${index + 1} 批${range}。只为下面这部分剧本生成镜头，不要重复前面批次已覆盖的内容，也不要提前写后面批次的内容。`
  ];
  if (previous !== undefined) {
    lines.push(`前面已生成 ${previous.seq} 个镜头，最后一个镜头属于“${previous.sceneLabel}”，画面：${previous.action}。本批的场次标注接着前面的编号。`);
  }
  return lines.join('\n');
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
    const aspectRatio = readOptionalText(source, { key: 'aspectRatio', label: '画幅', required: false, maxLength: ASPECT_RATIO_MAX_LENGTH }, errors);
    assertNoFieldErrors(errors);
    const params = normalizeStoryboardParams(typeof source.params === 'object' && source.params !== null ? source.params : source);
    return { workName, projectStyle, aspectRatio, params };
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
    const batches = planSceneBatches(episode.screenplayText, this.dependencies.sceneBatchMaxChars);

    context.reportProgress({ step: '生成分镜脚本', total: batches.length, done: 0 });
    const shots: ShotDraft[] = [];
    let remainingChars = episode.screenplayText.length;
    for (const [index, batch] of batches.entries()) {
      const isBatched = batches.length > 1;
      const isLast = index === batches.length - 1;
      // 剩余的镜头数与时长预算按本批正文占剩余正文的比例分配（镜头数向上取整，时长向下取整），最后一批取全部剩余，各批合计不超过整集上限。
      const share = isLast || remainingChars === 0 ? 1 : batch.text.length / remainingChars;
      const remainingShots = (params.maxShots ?? MAX_SHOTS_LIMIT) - shots.length;
      // 给后面的每一批至少留 1 个镜头。
      const shotCap = remainingShots - (batches.length - index - 1);
      if (isBatched && shotCap < 1) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `镜头总数上限太小：本集要分 ${batches.length} 批生成，每批至少需要 1 个镜头，请提高上限。` });
      }
      const target = episode.targetDurationSeconds;
      const remainingSeconds = target === null ? null : roundDown(target - sumSeconds(shots));
      const batchParams: StoryboardParams = isBatched ? { ...params, maxShots: Math.min(shotCap, Math.max(1, Math.ceil(remainingShots * share))) } : params;
      const batchSeconds = !isBatched || remainingSeconds === null ? target : roundDown(remainingSeconds * share);
      const continuesFromPrevious = shots.length > 0;

      const header = `【第 ${episode.seq} 集 ${episode.title}】\n梗概：${episode.synopsis}\n\n`;
      const material = isBatched ? `${header}${describeBatch(batch, index, batches.length, shots.at(-1))}\n\n${batch.text}` : `${header}${batch.text}`;
      const batchShots = await askModel(
        context,
        prompts,
        'storyboard',
        {
          material: wrapMaterial(material),
          entities: describeEntities(entities, descriptions),
          style: params.visualStyle ?? input.projectStyle ?? NO_STYLE,
          aspectRatio: describeAspectRatio(input.aspectRatio ?? null),
          shotRules: describeShotRules(batchParams, batchSeconds, isBatched),
          continuityRule: describeContinuity(params, continuesFromPrevious),
          audioRule: describeAudio(params),
          extra: params.extra ?? NOT_APPLICABLE
        },
        (json) => parseStoryboard(json, { params: batchParams, entities, maxTotalSeconds: batchSeconds, firstSeq: shots.length + 1 }),
        {
          overflowHint: isBatched
            ? '这一批场次的剧本仍然过长，请在剧本阶段把这一集或其中过长的场次拆短后重新生成。'
            : '本集剧本过长，请在剧本阶段把这一集拆短后重新生成。',
          tool: createStoryboardTool(params, continuesFromPrevious)
        }
      );
      shots.push(...batchShots);
      remainingChars -= batch.text.length;
      context.reportProgress({ step: '生成分镜脚本', total: batches.length, done: index + 1 });
    }
    const now = (this.dependencies.now?.() ?? new Date()).toISOString();
    storyboards.save(run.id, run.episodeId, shots, now);
    syncShotGroups(storyboards, run.id, groupMaxSecondsOf(params), now);
  }
}
