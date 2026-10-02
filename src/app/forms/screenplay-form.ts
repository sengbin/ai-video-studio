// ------------------------------------------------------------------------
// 名称：screenplay-form.ts
// 说明：剧本阶段表单（F4）的定义：对创意已确认的作品开始生成剧本，字段随作品形态变化；重新生成使用同一个表单，初始值为上次使用的参数；剧本列表的“添加”先用“选择作品”表单选作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：生成表单的作品由入口固定；“选择作品”表单只选择、不启动生成，选好后由页面再打开生成表单；创意未确认时不能打开表单。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { ScreenplayParams } from '../../domain/models/screenplay';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import {
  EPISODE_DURATION_MAX_SECONDS,
  EPISODE_DURATION_MIN_SECONDS,
  MAX_EPISODES_LIMIT,
  SCREENPLAY_EXTRA_MAX_LENGTH
} from '../../domain/rules/screenplay-rules';
import { ProjectService } from '../services/project-service';
import { ScreenplayService } from '../services/screenplay-service';
import { WorkService } from '../services/work-service';
import { SyncFormCatalog, FormDefinition, FormValues } from './form-definition';
import { FormFieldSchema } from './form-schema';

/** 剧本表单在表单目录中的名称，页面据此请求打开。 */
export const SCREENPLAY_FORM_NAMES = {
  start: 'screenplay.start',
  pick: 'screenplay.pick'
} as const;

/** 剧本表单依赖的服务与回调。 */
export interface ScreenplayFormDependencies {
  readonly projects: ProjectService;
  readonly works: WorkService;
  readonly screenplays: ScreenplayService;
  /** 生成已开始后调用，用于打开阶段产出层。 */
  readonly onStarted: (workId: number) => void;
  /** “选择作品”表单提交后调用，用于打开该作品的生成表单。 */
  readonly onPicked: (workId: number) => void;
}

const SUBMIT_LABEL = '开始生成';
const PICK_SUBMIT_LABEL = '下一步';
const PICK_FIELD_KEY = 'work';
const PICK_SEPARATOR = ' › ';
const NO_STARTABLE_MESSAGE = '没有可生成剧本的作品，请先在“创作”列表中确认创意。';
const PICK_REQUIRED_MESSAGE = '请选择所属作品。';

/** 生成参数转表单初始值：数字转为文本，未设置的项为空串。 */
function paramsToValues(params: ScreenplayParams): FormValues {
  return {
    maxEpisodeDurationSeconds: String(params.maxEpisodeDurationSeconds),
    maxEpisodes: String(params.maxEpisodes),
    extra: params.extra ?? ''
  };
}

/** 创建“生成剧本”表单的定义。 */
function createStartForm(dependencies: ScreenplayFormDependencies, workId: number): FormDefinition {
  const { works, screenplays, onStarted } = dependencies;
  const work = works.getWork(workId);
  screenplays.assertCanStart(workId);
  const lastParams = screenplays.getLastParams(workId);

  const fields: FormFieldSchema[] = [
    {
      key: 'maxEpisodeDurationSeconds',
      label: '单集最大时长（秒）',
      description: `${EPISODE_DURATION_MIN_SECONDS} 至 ${EPISODE_DURATION_MAX_SECONDS}；这是上限，剧本时长将按内容决定`,
      control: 'text',
      required: true
    }
  ];
  if (work.kind === 'series') {
    fields.push({
      key: 'maxEpisodes',
      label: '集数上限',
      description: `1 至 ${MAX_EPISODES_LIMIT}；内容不足时不会为达到上限而拆分`,
      control: 'text',
      required: true
    });
  }
  fields.push({
    key: 'extra',
    label: '补充要求',
    description: `可选，最多 ${SCREENPLAY_EXTRA_MAX_LENGTH} 字`,
    control: 'textarea',
    required: false,
    maxLength: SCREENPLAY_EXTRA_MAX_LENGTH
  });

  return {
    schema: { title: `生成剧本：${work.name}`, submitLabel: SUBMIT_LABEL, fields },
    initialValues: lastParams === undefined ? {} : paramsToValues(lastParams),
    submit: async (values) => {
      await screenplays.start(workId, values);
      onStarted(workId);
    }
  };
}

/**
 * 创建“选择作品”表单的定义：只列创意已确认的作品，选项标签为“项目 › 作品”。
 * @param projectId 限定在该项目内选择；缺省列出全部项目。
 */
function createPickForm(dependencies: ScreenplayFormDependencies, projectId: number | undefined): FormDefinition {
  const { projects, works, onPicked } = dependencies;
  const names = new Map(projects.listProjects().map((project) => [project.id, project.name]));
  const candidates = works
    .listAllWorks()
    .filter((work) => work.canStartScreenplay && (projectId === undefined || work.projectId === projectId))
    .map((work) => ({ id: work.id, label: `${names.get(work.projectId) ?? ''}${PICK_SEPARATOR}${work.name}` }));
  if (candidates.length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_STARTABLE_MESSAGE });
  }
  const field: FormFieldSchema = {
    key: PICK_FIELD_KEY,
    label: '所属作品',
    description: '只列出创意已确认的作品',
    control: 'select',
    required: true,
    options: candidates.map((candidate) => candidate.label)
  };
  return {
    schema: { title: '生成剧本', submitLabel: PICK_SUBMIT_LABEL, fields: [field] },
    initialValues: candidates.length === 1 ? { [PICK_FIELD_KEY]: candidates[0].label } : {},
    submit: (values) => {
      const picked = candidates.find((candidate) => candidate.label === values[PICK_FIELD_KEY]);
      if (picked === undefined) {
        throw new ValidationError({ [PICK_FIELD_KEY]: PICK_REQUIRED_MESSAGE });
      }
      onPicked(picked.id);
    }
  };
}

/**
 * 创建剧本表单目录：`screenplay.start` 的参数为 `{ workId }`，`screenplay.pick` 的参数为 `{ projectId? }`。
 * @param dependencies 服务与回调。
 */
export function createScreenplayFormCatalog(dependencies: ScreenplayFormDependencies): SyncFormCatalog {
  return new Map([
    [SCREENPLAY_FORM_NAMES.start, (params) => createStartForm(dependencies, readEntityId({ id: readRecord(params).workId }, '作品'))],
    [
      SCREENPLAY_FORM_NAMES.pick,
      (params) => {
        const projectId = readRecord(params ?? {}).projectId;
        return createPickForm(dependencies, typeof projectId === 'number' ? projectId : undefined);
      }
    ]
  ]);
}
