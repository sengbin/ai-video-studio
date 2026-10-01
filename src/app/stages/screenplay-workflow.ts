// ------------------------------------------------------------------------
// 名称：screenplay-workflow.ts
// 说明：剧本阶段工作流：依据已确认的创意章节生成剧本包正文，再从正文抽取集和实体；支持中断后继续与重新抽取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：正文与抽取结果都保存在剧本包表，重试时已有正文则跳过生成、已有抽取结果则跳过抽取；重新抽取时先清除抽取结果再执行。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { ScreenplayParams } from '../../domain/models/screenplay';
import { WorkKind } from '../../domain/models/work';
import { ChapterRepository } from '../../domain/ports/chapter-repository';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { FieldErrors, assertNoFieldErrors, readOptionalChoice, readRecord, readText } from '../../domain/rules/field-readers';
import { WORK_NAME_MAX_LENGTH } from '../../domain/rules/work-rules';
import { ScreenplayContext, normalizeScreenplayParams, parseScreenplayText, parseStructure } from '../../domain/rules/screenplay-rules';
import { askModel } from './ask-model';
import { SUBMIT_SCREENPLAY_TOOL, createStructureTool } from './output-tools/screenplay-output-tools';
import { wrapMaterial } from './prompt-templates';
import { StageContext, StageWorkflow } from './stage-workflow';

/** 剧本阶段保存到阶段记录的输入快照。 */
export interface ScreenplayRunInput {
  readonly workKind: WorkKind;
  /** 单个短视频的集标题取作品名称，生成时的名称记录在快照里。 */
  readonly workName: string;
  readonly params: ScreenplayParams;
}

/** 剧本工作流的依赖。 */
export interface ScreenplayWorkflowDependencies {
  readonly chapters: ChapterRepository;
  readonly screenplays: ScreenplayRepository;
  readonly prompts: PromptTemplates;
  readonly now?: () => Date;
}

/** 各提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const SCREENPLAY_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  'screenplay-text': ['material', 'workKind', 'params', 'episodeRule', 'maxDuration'],
  'screenplay-extract': ['screenplay', 'episodeRule', 'maxDuration', 'episodeOutput']
};

const WORK_KINDS: readonly WorkKind[] = ['single', 'series'];
const NOT_APPLICABLE = '（无）';
const TOTAL_STEPS = 2;

/** 单个短视频与多集短片在提示词中的说明。 */
function describeWorkKind(kind: WorkKind): string {
  return kind === 'single' ? '单个短视频（只有 1 集）' : '多集短片（按剧情拆分为多集）';
}

/** 生成正文时对集数的要求。 */
function describeTextEpisodeRule(kind: WorkKind, params: ScreenplayParams): string {
  return kind === 'single'
    ? '这是单个短视频，整部剧本就是 1 集，不分集。'
    : `按剧情拆分为多集，最多 ${params.maxEpisodes} 集；上限不是目标，按故事的完整度决定集数，每集要有相对完整的起承转合，集与集之间保留悬念衔接。剧本中每集以“第 N 集 标题”开头。`;
}

/** 抽取时对集数的要求。 */
function describeExtractEpisodeRule(kind: WorkKind, params: ScreenplayParams): string {
  return kind === 'single' ? '这是单个短视频，只有 1 集。' : `按剧本中的集划分，最多 ${params.maxEpisodes} 集。`;
}

/** 抽取时对每集输出的要求。 */
function describeEpisodeOutput(kind: WorkKind): string {
  return kind === 'single'
    ? 'episodes 只包含 1 项：填写 synopsis，不需要 title 和 screenplayText。'
    : 'episodes 每项填写 title 和 synopsis，screenplayText 从剧本正文中原样摘录属于该集的部分，不得改写、删减或合并。';
}

/** 剧本阶段工作流。 */
export class ScreenplayWorkflow implements StageWorkflow {
  readonly stage = 'screenplay' as const;

  constructor(private readonly dependencies: ScreenplayWorkflowDependencies) {}

  normalizeInput(rawInput: unknown): Readonly<Record<string, unknown>> {
    const source = readRecord(rawInput);
    const errors: FieldErrors = {};
    const workKind = readOptionalChoice(source, 'workKind', '作品形态', WORK_KINDS, errors);
    if (workKind === null && errors.workKind === undefined) {
      errors.workKind = '作品形态不能为空。';
    }
    const workName = readText(source, { key: 'workName', label: '作品名称', required: true, maxLength: WORK_NAME_MAX_LENGTH }, errors);
    assertNoFieldErrors(errors);

    const params = normalizeScreenplayParams(typeof source.params === 'object' && source.params !== null ? source.params : source, workKind as WorkKind);
    return { workKind, workName, params };
  }

  async execute(context: StageContext): Promise<void> {
    const { run } = context;
    const { chapters, screenplays, prompts } = this.dependencies;
    // 输入快照由 normalizeInput 生成，结构可信。
    const input = run.input as unknown as ScreenplayRunInput;
    const { workKind, params } = input;
    const single = workKind === 'single';
    const now = (): string => (this.dependencies.now?.() ?? new Date()).toISOString();

    const report = (step: string, done: number): void => context.reportProgress({ step, total: TOTAL_STEPS, done });

    let screenplay = screenplays.find(run.id);
    if (screenplay === undefined) {
      const upstream = run.sourceRunId === null ? [] : chapters.list(run.sourceRunId);
      if (upstream.length === 0) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有找到已确认的创意章节，请先确认创意。' });
      }
      report('生成剧本包正文', 0);
      const text = await askModel(
        context,
        prompts,
        'screenplay-text',
        {
          material: wrapMaterial(upstream.map((chapter) => `【第 ${chapter.seq} 章 ${chapter.title}】\n${chapter.content}`).join('\n\n')),
          workKind: describeWorkKind(workKind),
          params: params.extra === null ? NOT_APPLICABLE : `补充要求：${params.extra}`,
          episodeRule: describeTextEpisodeRule(workKind, params),
          maxDuration: String(params.maxEpisodeDurationSeconds)
        },
        (json) => parseScreenplayText(json, workKind),
        { overflowHint: '创意章节过长，请在创意阶段精简章节后重新生成。', tool: SUBMIT_SCREENPLAY_TOOL }
      );
      screenplays.create(run.id, text, now());
      screenplay = screenplays.find(run.id);
    }
    if (screenplay === undefined) {
      throw new Error(`阶段记录 ${run.id} 的剧本包写入后读取失败。`);
    }

    if (screenplay.structure === null) {
      report('抽取集和实体', 1);
      const parseContext: ScreenplayContext = { workKind, workName: input.workName, params };
      const { fullText } = screenplay;
      const structure = await askModel(
        context,
        prompts,
        'screenplay-extract',
        {
          screenplay: wrapMaterial(fullText),
          episodeRule: describeExtractEpisodeRule(workKind, params),
          maxDuration: String(params.maxEpisodeDurationSeconds),
          episodeOutput: describeEpisodeOutput(workKind)
        },
        (json) => parseStructure(json, parseContext, fullText),
        {
          overflowHint: single ? '剧本正文过长，请缩短后重新抽取。' : '剧本正文过长，请缩短正文或减少集数后重新抽取。',
          tool: createStructureTool(single)
        }
      );
      screenplays.saveStructure(run.id, structure, now());
    }
    report('已完成', TOTAL_STEPS);
  }
}
