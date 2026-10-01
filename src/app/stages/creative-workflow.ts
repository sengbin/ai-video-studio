// ------------------------------------------------------------------------
// 名称：creative-workflow.ts
// 说明：创意阶段工作流：整理素材（文字、图片、小说分段要点）、规划大纲、逐章生成并逐章保存，支持中断后继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：进度（分段要点、图片描述、大纲）保存在阶段记录的 progress.detail 中；章节保存在章节表，重试时跳过已完成的部分。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { ChapterOutlineItem, CreativeParams } from '../../domain/models/creative';
import { StageProgress } from '../../domain/models/stage-run';
import { ChapterRepository } from '../../domain/ports/chapter-repository';
import { CreativeSourceReader } from '../../domain/ports/creative-source-reader';
import { normalizeCreativeParams, parseChapter, parseOutline, parseSummary } from '../../domain/rules/creative-rules';
import { FieldErrors, assertNoFieldErrors, readOptionalChoice, readRecord } from '../../domain/rules/field-readers';
import { NovelSegment, NovelSplitSettings, splitNovel } from '../../domain/rules/novel-splitter';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { AskOptions, askModel } from './ask-model';
import { SUBMIT_CHAPTER_TOOL, SUBMIT_SUMMARY_TOOL, createOutlineTool } from './output-tools/creative-output-tools';
import { wrapMaterial } from './prompt-templates';
import { StageContext, StageWorkflow } from './stage-workflow';

/** 素材来源：文字灵感、灵感图片、小说原文。 */
export type CreativeSourceType = 'text' | 'image' | 'novel';

/** 创意阶段保存到阶段记录的输入快照。 */
export interface CreativeRunInput {
  readonly sourceType: CreativeSourceType;
  readonly params: CreativeParams;
}

/** 创意工作流的依赖。 */
export interface CreativeWorkflowDependencies {
  readonly chapters: ChapterRepository;
  readonly sources: CreativeSourceReader;
  readonly prompts: PromptTemplates;
  /** 读取当前的小说分段设置。 */
  readonly getSplitSettings: () => NovelSplitSettings;
  readonly now?: () => Date;
}

/** 各提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const CREATIVE_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  system: [],
  'creative-summary': ['segmentIndex', 'segmentCount', 'segmentTitle', 'segment'],
  'creative-digest-images': ['imageCount'],
  'creative-outline': ['sourceKind', 'material', 'params', 'minWords', 'maxWords', 'maxChapters', 'sourcesRule', 'sourcesExample'],
  'creative-chapter': [
    'seq',
    'total',
    'material',
    'params',
    'outline',
    'chapterTitle',
    'chapterSummary',
    'previousEnding',
    'sourceText',
    'minWords',
    'maxWords'
  ]
};

const SOURCE_TYPES: readonly CreativeSourceType[] = ['text', 'image', 'novel'];
const SOURCE_KIND_LABELS: Readonly<Record<CreativeSourceType, string>> = {
  text: '文字灵感',
  image: '灵感图片',
  novel: '小说原文'
};
const NO_IDEA_TEXT = '（没有提供具体灵感，请依据题材、基调和补充要求创作。）';
const NOT_APPLICABLE = '（无）';
const PREVIOUS_ENDING_CHARS = 300;

/** 保存在阶段记录 progress.detail 中的创意进度，用于中断后继续。 */
interface CreativeProgressDetail {
  segmentCount: number;
  summaries: string[];
  digest: string | null;
  outline: ChapterOutlineItem[] | null;
}

/** 一次执行中共用的状态与辅助函数。 */
interface Environment {
  readonly context: StageContext;
  readonly input: CreativeRunInput;
  readonly state: CreativeProgressDetail;
  readonly segments: readonly NovelSegment[];
  readonly savedChapters: Map<number, { title: string; content: string }>;
  report(step: string): void;
  ask<T>(template: string, variables: Record<string, string>, parse: (json: unknown) => T, options: AskOptions): Promise<T>;
}

/** 从阶段记录的进度中读取创意进度，缺失或格式不对时视为从头开始。 */
function readDetail(progress: StageProgress | null): CreativeProgressDetail {
  const detail = progress?.detail;
  const source = typeof detail === 'object' && detail !== null ? (detail as Partial<CreativeProgressDetail>) : {};
  return {
    segmentCount: typeof source.segmentCount === 'number' ? source.segmentCount : 0,
    summaries: Array.isArray(source.summaries) ? source.summaries.filter((item) => typeof item === 'string') : [],
    digest: typeof source.digest === 'string' ? source.digest : null,
    outline: Array.isArray(source.outline) ? source.outline : null
  };
}

/** 把生成参数整理为提示词中的“创作要求”文字。 */
function formatParams(params: CreativeParams): string {
  const lines = [
    params.genre === null ? null : `题材：${params.genre}`,
    params.tone === null ? null : `基调：${params.tone}`,
    params.preserve === null ? null : `必须保留的内容：${params.preserve}`,
    params.adjust === null ? null : `允许调整的内容：${params.adjust}`,
    params.extra === null ? null : `补充要求：${params.extra}`
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? NOT_APPLICABLE : lines.join('\n');
}

/** 一段原文的标签，如“第 3 段 第三章 归途”。 */
function segmentLabel(segment: NovelSegment): string {
  return segment.title === null ? `第 ${segment.index} 段` : `第 ${segment.index} 段 ${segment.title}`;
}

/** 创意阶段工作流。 */
export class CreativeWorkflow implements StageWorkflow {
  readonly stage = 'creative' as const;

  constructor(private readonly dependencies: CreativeWorkflowDependencies) {}

  normalizeInput(rawInput: unknown): Readonly<Record<string, unknown>> {
    const source = readRecord(rawInput);
    const errors: FieldErrors = {};

    const sourceType = readOptionalChoice(source, 'sourceType', '素材来源', SOURCE_TYPES, errors);
    if (sourceType === null && errors.sourceType === undefined) {
      errors.sourceType = '素材来源不能为空。';
    }

    let params: CreativeParams | undefined;
    try {
      const rawParams = typeof source.params === 'object' && source.params !== null ? source.params : source;
      params = normalizeCreativeParams(rawParams);
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      Object.assign(errors, error.fieldErrors);
    }
    assertNoFieldErrors(errors);
    return { sourceType, params };
  }

  async execute(context: StageContext): Promise<void> {
    const { run } = context;
    // 输入快照由 normalizeInput 生成，结构可信。
    const input = run.input as unknown as CreativeRunInput;
    const state = readDetail(run.progress);
    const segments = input.sourceType === 'novel' ? this.loadSegments(run.workId) : [];
    if (state.segmentCount !== 0 && state.segmentCount !== segments.length) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '小说分段设置已变化，无法从中断处继续，请重新生成。' });
    }
    state.segmentCount = segments.length;

    const environment = this.createEnvironment(context, input, state, segments);
    const material = await this.prepareMaterial(environment);
    const outline = await this.planOutline(environment, material);
    await this.writeChapters(environment, material, outline);
  }

  /** 组装一次执行的共用状态与提问函数。 */
  private createEnvironment(
    context: StageContext,
    input: CreativeRunInput,
    state: CreativeProgressDetail,
    segments: readonly NovelSegment[]
  ): Environment {
    const { prompts, chapters } = this.dependencies;
    const savedChapters = new Map(chapters.list(context.run.id).map((chapter) => [chapter.seq, chapter]));

    const report = (step: string): void => {
      const materialSteps = input.sourceType === 'novel' ? segments.length : input.sourceType === 'image' ? 1 : 0;
      const materialDone =
        input.sourceType === 'novel' ? state.summaries.length : input.sourceType === 'image' && state.digest !== null ? 1 : 0;
      context.reportProgress({
        step,
        total: materialSteps + 1 + (state.outline?.length ?? 0),
        done: materialDone + (state.outline === null ? 0 : 1) + savedChapters.size,
        detail: { ...state }
      });
    };

    const ask = <T>(template: string, variables: Record<string, string>, parse: (json: unknown) => T, options: AskOptions): Promise<T> =>
      askModel(context, prompts, template, variables, parse, options);

    return { context, input, state, segments, savedChapters, report, ask };
  }

  /** 读取并切分小说原文。 */
  private loadSegments(workId: number): NovelSegment[] {
    const text = this.dependencies.sources.readNovelText(workId);
    if (text === undefined || text.trim().length === 0) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有找到小说原文，请先上传原作文件。' });
    }
    return splitNovel(text, this.dependencies.getSplitSettings());
  }

  /**
   * 整理素材为文字：文字灵感直接使用；图片先描述；小说逐段提取要点。已完成的步骤不重复。
   * @returns 用于大纲的素材文字，已包裹为数据段。
   */
  private async prepareMaterial(environment: Environment): Promise<string> {
    const { input, state, segments, context, report, ask } = environment;
    const { params, sourceType } = input;

    if (sourceType === 'text') {
      return wrapMaterial(params.idea ?? NO_IDEA_TEXT);
    }

    if (sourceType === 'image') {
      if (state.digest === null) {
        const images = this.dependencies.sources.readImages(context.run.workId);
        if (images.length === 0) {
          throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '没有找到灵感图片，请先添加图片。' });
        }
        report('分析图片');
        state.digest = await ask('creative-digest-images', { imageCount: String(images.length) }, parseSummary, {
          images,
          overflowHint: '请减少图片数量后重试。',
          tool: SUBMIT_SUMMARY_TOOL
        });
        report('分析图片');
      }
      return wrapMaterial(state.digest);
    }

    while (state.summaries.length < segments.length) {
      const segment = segments[state.summaries.length];
      report(`阅读原文：${segmentLabel(segment)}`);
      const summary = await ask(
        'creative-summary',
        {
          segmentIndex: String(segment.index),
          segmentCount: String(segments.length),
          segmentTitle: segment.title ?? '无',
          segment: wrapMaterial(segment.text)
        },
        parseSummary,
        { overflowHint: '请在设置中调小“每段字数上限”后重试。', tool: SUBMIT_SUMMARY_TOOL }
      );
      state.summaries.push(summary);
    }
    return wrapMaterial(segments.map((segment, index) => `【${segmentLabel(segment)}】\n${state.summaries[index]}`).join('\n\n'));
  }

  /** 规划章节大纲；已有大纲时直接沿用。 */
  private async planOutline(environment: Environment, material: string): Promise<ChapterOutlineItem[]> {
    const { input, state, segments, report, ask } = environment;
    if (state.outline !== null) {
      return state.outline;
    }
    const { params, sourceType } = input;
    report('规划大纲');
    const novel = sourceType === 'novel';
    const outline = await ask(
      'creative-outline',
      {
        sourceKind: SOURCE_KIND_LABELS[sourceType],
        material,
        params: formatParams(params),
        minWords: String(params.chapterMinWords),
        maxWords: String(params.chapterMaxWords),
        maxChapters: String(params.maxChapters),
        sourcesRule: novel ? `每章必须用 sources 列出本章依据的原文分段序号（1 到 ${segments.length}，可多个），序号取自上面各段前的编号。` : '',
        sourcesExample: novel ? ', "sources": [1, 2]' : ''
      },
      (json) => parseOutline(json, params, segments.length),
      { overflowHint: '请在设置中增大“每段字数上限”以减少分段数，或缩短素材后重试。', tool: createOutlineTool(novel) }
    );
    state.outline = outline;
    report('规划大纲');
    return outline;
  }

  /** 逐章生成并保存；已保存的章节跳过。 */
  private async writeChapters(environment: Environment, material: string, outline: readonly ChapterOutlineItem[]): Promise<void> {
    const { input, segments, savedChapters, context, report, ask } = environment;
    const { params, sourceType } = input;
    const outlineText = outline.map((item) => `${item.seq}. ${item.title}：${item.summary}`).join('\n');

    for (const item of outline) {
      if (savedChapters.has(item.seq)) {
        continue;
      }
      report(`生成第 ${item.seq} / ${outline.length} 章`);
      const previous = savedChapters.get(item.seq - 1);
      const sourceText =
        sourceType === 'novel'
          ? wrapMaterial(item.sources.map((index) => `【${segmentLabel(segments[index - 1])}】\n${segments[index - 1].text}`).join('\n\n'))
          : NOT_APPLICABLE;

      const draft = await ask(
        'creative-chapter',
        {
          seq: String(item.seq),
          total: String(outline.length),
          material: sourceType === 'novel' ? NOT_APPLICABLE : material,
          params: formatParams(params),
          outline: outlineText,
          chapterTitle: item.title,
          chapterSummary: item.summary,
          previousEnding: previous === undefined ? '（这是第一章）' : `……${previous.content.slice(-PREVIOUS_ENDING_CHARS)}`,
          sourceText,
          minWords: String(params.chapterMinWords),
          maxWords: String(params.chapterMaxWords)
        },
        (json) => parseChapter(json, item.seq),
        { overflowHint: '请在设置中调小“每段字数上限”后重试。', tool: SUBMIT_CHAPTER_TOOL }
      );
      this.dependencies.chapters.save(context.run.id, draft, (this.dependencies.now?.() ?? new Date()).toISOString());
      savedChapters.set(item.seq, draft);
    }
    report('已完成');
  }
}
