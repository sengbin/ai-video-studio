// ------------------------------------------------------------------------
// 名称：work-form.ts
// 说明：创意阶段表单（F3）的定义：新建作品并开始生成，或对已有作品重新生成创意；字段随素材来源变化。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：素材来源与所属项目由入口决定，不在表单中选择；提交时先校验全部字段，创建作品后再启动生成，启动失败会撤销刚创建的作品，让用户可以直接重试。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { CreativeParams } from '../../domain/models/creative';
import { GENRE_OPTIONS, TONE_OPTIONS } from '../../domain/models/option-sets';
import { WorkSourceType } from '../../domain/models/work';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import {
  CREATIVE_CHOICE_MAX_LENGTH,
  CREATIVE_EXTRA_MAX_LENGTH,
  CREATIVE_IDEA_MAX_LENGTH,
  CREATIVE_PRESERVE_MAX_LENGTH,
  DEFAULT_CHAPTER_MAX_WORDS,
  DEFAULT_CHAPTER_MIN_WORDS,
  DEFAULT_MAX_CHAPTERS,
  normalizeCreativeParams
} from '../../domain/rules/creative-rules';
import {
  IMAGE_EXTENSIONS,
  IMAGE_FIELD_KEY,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_FILES,
  NOVEL_EXTENSIONS,
  NOVEL_FIELD_KEY,
  NOVEL_MAX_BYTES,
  SOURCE_TYPE_LABELS,
  WORK_KIND_LABELS,
  WORK_NAME_MAX_LENGTH,
  NormalizedWorkCreation,
  normalizeWorkCreation
} from '../../domain/rules/work-rules';
import { ProjectService } from '../services/project-service';
import { StageService } from '../services/stage-service';
import { DUPLICATE_WORK_NAME_MESSAGE, WorkService } from '../services/work-service';
import { FormCatalog, FormDefinition, FormValues } from './form-definition';
import { FormFieldSchema } from './form-schema';

/** 创意表单在表单目录中的名称，页面据此请求打开。 */
export const WORK_FORM_NAMES = {
  create: 'work.create',
  regenerate: 'work.regenerate'
} as const;

/** 创意表单依赖的服务与回调。 */
export interface WorkFormDependencies {
  readonly projects: ProjectService;
  readonly works: WorkService;
  readonly stages: StageService;
  /** 生成已开始（创建作品并启动生成，或重新生成）后调用，用于打开阶段产出页。 */
  readonly onStarted: (workId: number) => void;
}

const SOURCE_TYPES: readonly WorkSourceType[] = ['text', 'image', 'novel'];
const SUBMIT_LABEL_CREATE = '创建并生成';
const SUBMIT_LABEL_REGENERATE = '开始生成';
const LABEL_SINGLE_KIND = WORK_KIND_LABELS.single;

/** 读取入口传来的素材来源，必须是三种之一。 */
function readSourceType(value: unknown): WorkSourceType {
  if (typeof value !== 'string' || !SOURCE_TYPES.includes(value as WorkSourceType)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '素材来源无效。' });
  }
  return value as WorkSourceType;
}

/** 作品名称、形态与素材文件字段，只在新建作品时出现。 */
function createWorkFields(sourceType: WorkSourceType): FormFieldSchema[] {
  const fields: FormFieldSchema[] = [
    {
      key: 'workName',
      label: '作品名称',
      description: `作品在项目内的唯一名称，最多 ${WORK_NAME_MAX_LENGTH} 字`,
      control: 'text',
      required: true,
      maxLength: WORK_NAME_MAX_LENGTH,
      placeholder: '例如：雨夜来客',
      checkUnique: true
    },
    {
      key: 'kind',
      label: '作品形态',
      description: '单个短视频只有 1 集；多集短片在确认剧本后按剧情拆分为多集',
      control: 'radio',
      required: true,
      options: Object.values(WORK_KIND_LABELS)
    }
  ];
  if (sourceType === 'image') {
    fields.push({
      key: IMAGE_FIELD_KEY,
      label: '灵感图片',
      description: `至少 1 张，最多 ${IMAGE_MAX_FILES} 张；PNG、JPEG、WebP，每张不超过 ${IMAGE_MAX_BYTES / (1024 * 1024)} MB，可调整顺序`,
      control: 'file',
      required: true,
      accept: IMAGE_EXTENSIONS,
      multiple: true,
      maxFiles: IMAGE_MAX_FILES,
      maxFileBytes: IMAGE_MAX_BYTES
    });
  } else if (sourceType === 'novel') {
    fields.push({
      key: NOVEL_FIELD_KEY,
      label: '原作文件',
      description: `TXT 或 Markdown，UTF-8 编码，不超过 ${NOVEL_MAX_BYTES / (1024 * 1024)} MB；长篇会按“模型”设置中的分段方式逐段处理`,
      control: 'file',
      required: true,
      accept: NOVEL_EXTENSIONS,
      multiple: false,
      maxFileBytes: NOVEL_MAX_BYTES
    });
  }
  return fields;
}

/** 影响生成的字段：随素材来源显示不同的字段与文案。 */
function createParamFields(sourceType: WorkSourceType): FormFieldSchema[] {
  const fields: FormFieldSchema[] = [];
  if (sourceType === 'text') {
    fields.push({
      key: 'idea',
      label: '创作主题或灵感',
      description: `一句话或一段文字都可以，最多 ${CREATIVE_IDEA_MAX_LENGTH} 字；不填则依据题材、基调和补充要求创作`,
      control: 'textarea',
      required: false,
      maxLength: CREATIVE_IDEA_MAX_LENGTH
    });
  }
  fields.push(
    {
      key: 'genre',
      label: '题材',
      description: '可选，也可选择“其他”手动输入',
      control: 'select',
      required: false,
      maxLength: CREATIVE_CHOICE_MAX_LENGTH,
      options: GENRE_OPTIONS,
      allowCustom: true
    },
    {
      key: 'tone',
      label: '基调',
      description: '可选，也可选择“其他”手动输入',
      control: 'select',
      required: false,
      maxLength: CREATIVE_CHOICE_MAX_LENGTH,
      options: TONE_OPTIONS,
      allowCustom: true
    },
    {
      key: 'chapterMinWords',
      label: '每章最少字数',
      description: '最低允许 100 字；常规叙事推荐设为 1000 字',
      control: 'text',
      required: true
    },
    {
      key: 'chapterMaxWords',
      label: '每章最多字数',
      description: '不能小于每章最少字数；超出范围的章节会被要求重写',
      control: 'text',
      required: true
    },
    {
      key: 'maxChapters',
      label: '章节数上限',
      description: '1 至 100；内容不足时不会为达到上限而扩写',
      control: 'text',
      required: true
    }
  );
  if (sourceType !== 'text') {
    fields.push({
      key: 'preserve',
      label: sourceType === 'image' ? '图片中必须保留的元素' : '必须保留的内容',
      description: `可选，最多 ${CREATIVE_PRESERVE_MAX_LENGTH} 字`,
      control: 'textarea',
      required: false,
      maxLength: CREATIVE_PRESERVE_MAX_LENGTH
    });
  }
  if (sourceType === 'novel') {
    fields.push({
      key: 'adjust',
      label: '允许调整的内容',
      description: `可选，最多 ${CREATIVE_PRESERVE_MAX_LENGTH} 字；不填则尽量忠实于原作`,
      control: 'textarea',
      required: false,
      maxLength: CREATIVE_PRESERVE_MAX_LENGTH
    });
  }
  fields.push({
    key: 'extra',
    label: '补充要求',
    description: `可选，最多 ${CREATIVE_EXTRA_MAX_LENGTH} 字`,
    control: 'textarea',
    required: false,
    maxLength: CREATIVE_EXTRA_MAX_LENGTH
  });
  return fields;
}

/** 生成参数转表单初始值：数字转为文本，未设置的项为空串。 */
function paramsToValues(params: CreativeParams): FormValues {
  return {
    idea: params.idea ?? '',
    genre: params.genre ?? '',
    tone: params.tone ?? '',
    chapterMinWords: String(params.chapterMinWords),
    chapterMaxWords: String(params.chapterMaxWords),
    maxChapters: String(params.maxChapters),
    preserve: params.preserve ?? '',
    adjust: params.adjust ?? '',
    extra: params.extra ?? ''
  };
}

/** 新建时的默认参数值。 */
const DEFAULT_PARAM_VALUES: FormValues = {
  chapterMinWords: String(DEFAULT_CHAPTER_MIN_WORDS),
  chapterMaxWords: String(DEFAULT_CHAPTER_MAX_WORDS),
  maxChapters: String(DEFAULT_MAX_CHAPTERS)
};

/** 合并多次校验的字段错误后一并抛出，让用户一次看到全部问题。 */
function collectFieldErrors(checks: ReadonlyArray<() => void>): void {
  const errors: Record<string, string> = {};
  for (const check of checks) {
    try {
      check();
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      Object.assign(errors, error.fieldErrors);
    }
  }
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
}

/**
 * 创建“新建作品并生成”表单的定义。
 * @param dependencies 服务与回调。
 * @param projectId 所属项目。
 * @param sourceType 素材来源。
 */
function createNewWorkForm(dependencies: WorkFormDependencies, projectId: number, sourceType: WorkSourceType): FormDefinition {
  const { works, stages, onStarted } = dependencies;
  return {
    schema: {
      title: `新建作品（${SOURCE_TYPE_LABELS[sourceType]}）`,
      submitLabel: SUBMIT_LABEL_CREATE,
      fields: [...createWorkFields(sourceType), ...createParamFields(sourceType)]
    },
    initialValues: { kind: LABEL_SINGLE_KIND, ...DEFAULT_PARAM_VALUES },
    checkField: (key, value) =>
      key === 'workName' && !works.isWorkNameAvailable(projectId, value) ? DUPLICATE_WORK_NAME_MESSAGE : undefined,
    submit: async (values) => {
      const parsed: { creation?: NormalizedWorkCreation; params?: CreativeParams } = {};
      collectFieldErrors([
        () => {
          parsed.creation = normalizeWorkCreation(values, sourceType);
        },
        () => {
          parsed.params = normalizeCreativeParams(values);
        }
      ]);
      const { creation, params } = parsed;
      if (creation === undefined || params === undefined) {
        return;
      }

      const work = works.createWork(projectId, creation);
      try {
        await stages.startCreative(work.id, params);
      } catch (error) {
        // 没能开始生成（例如 Copilot 不可用）：撤销刚创建的作品，用户修正后可以直接再次提交。
        works.deleteWork(work.id);
        throw error;
      }
      onStarted(work.id);
    }
  };
}

/**
 * 创建“重新生成创意”表单的定义：作品与素材沿用，只调整生成参数；初始值为上次使用的参数。
 * @param dependencies 服务与回调。
 * @param workId 作品标识。
 */
function createRegenerateForm(dependencies: WorkFormDependencies, workId: number): FormDefinition {
  const { works, stages, onStarted } = dependencies;
  const work = works.getWork(workId);
  const lastParams = stages.getLastCreativeParams(workId);
  return {
    schema: {
      title: `重新生成创意：${work.name}`,
      submitLabel: SUBMIT_LABEL_REGENERATE,
      fields: createParamFields(work.sourceType)
    },
    initialValues: lastParams === undefined ? DEFAULT_PARAM_VALUES : paramsToValues(lastParams),
    submit: async (values) => {
      await stages.startCreative(workId, normalizeCreativeParams(values));
      onStarted(workId);
    }
  };
}

/**
 * 创建创意表单目录：新建的参数为 `{ projectId, sourceType }`，重新生成的参数为 `{ workId }`。
 * @param dependencies 服务与回调。
 */
export function createWorkFormCatalog(dependencies: WorkFormDependencies): FormCatalog {
  return new Map([
    [
      WORK_FORM_NAMES.create,
      (params) => {
        const source = readRecord(params);
        const project = dependencies.projects.getProject(readEntityId({ id: source.projectId }, '项目'));
        return createNewWorkForm(dependencies, project.id, readSourceType(source.sourceType));
      }
    ],
    [
      WORK_FORM_NAMES.regenerate,
      (params) => createRegenerateForm(dependencies, readEntityId({ id: readRecord(params).workId }, '作品'))
    ]
  ]);
}
