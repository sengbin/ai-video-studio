// ------------------------------------------------------------------------
// 名称：screenplay-form.ts
// 说明：剧本阶段表单（F4）的定义：对创意已确认的作品开始生成剧本，字段随作品形态变化；重新生成使用同一个表单，初始值为上次使用的参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：作品由入口固定，不提供所属项目与作品下拉；创意未确认时不能打开表单。
// ------------------------------------------------------------------------

import { ScreenplayParams } from '../../domain/models/screenplay';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import {
  EPISODE_DURATION_MAX_SECONDS,
  EPISODE_DURATION_MIN_SECONDS,
  MAX_EPISODES_LIMIT,
  SCREENPLAY_EXTRA_MAX_LENGTH
} from '../../domain/rules/screenplay-rules';
import { ScreenplayService } from '../services/screenplay-service';
import { WorkService } from '../services/work-service';
import { FormCatalog, FormDefinition, FormValues } from './form-definition';
import { FormFieldSchema } from './form-schema';

/** 剧本表单在表单目录中的名称，页面据此请求打开。 */
export const SCREENPLAY_FORM_NAMES = {
  start: 'screenplay.start'
} as const;

/** 剧本表单依赖的服务与回调。 */
export interface ScreenplayFormDependencies {
  readonly works: WorkService;
  readonly screenplays: ScreenplayService;
  /** 生成已开始后调用，用于打开阶段产出层。 */
  readonly onStarted: (workId: number) => void;
}

const SUBMIT_LABEL = '开始生成';

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
 * 创建剧本表单目录：参数为 `{ workId }`。
 * @param dependencies 服务与回调。
 */
export function createScreenplayFormCatalog(dependencies: ScreenplayFormDependencies): FormCatalog {
  return new Map([
    [SCREENPLAY_FORM_NAMES.start, (params) => createStartForm(dependencies, readEntityId({ id: readRecord(params).workId }, '作品'))]
  ]);
}
