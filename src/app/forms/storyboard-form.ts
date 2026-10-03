// ------------------------------------------------------------------------
// 名称：storyboard-form.ts
// 说明：分镜脚本阶段表单（F5）的定义：对剧本已确认的作品为一集或多集开始生成分镜脚本；重新生成使用同一个表单，初始值为上次使用的参数；分镜列表的“添加”先用“选择作品”表单选作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：目标视频模型、画幅、分辨率保存为作品默认生成参数（与工作台“生成参数”共用），不属于分镜脚本的生成参数；画幅另随生成请求传给分镜工作流用于提示构图；提交时按所选模型的能力检查画幅、分辨率与单组最长时长，没有可用视频模型时不显示这三项；生成表单的作品由入口固定；多集时可多选集，一次为每个所选集各生成一份；剧本未确认时不能打开表单。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { VideoCapability } from '../../domain/models/model-capability';
import { VISUAL_STYLE_OPTIONS } from '../../domain/models/option-sets';
import { SOUND_KIND_LABELS, SoundKind, StoryboardParams } from '../../domain/models/storyboard';
import { assertNoFieldErrors, readEntityId, readRecord } from '../../domain/rules/field-readers';
import { ProfileChanges } from '../../domain/rules/generation-profile-rules';
import {
  AUDIO_MODE_LABELS,
  CONTINUITY_LABELS,
  MAX_SHOTS_LIMIT,
  SHOT_SECONDS_MAX,
  SHOT_SECONDS_MIN,
  STORYBOARD_EXTRA_MAX_LENGTH,
  STORYBOARD_STYLE_MAX_LENGTH,
  normalizeStoryboardParams
} from '../../domain/rules/storyboard-rules';
import { DEFAULT_GROUP_MAX_SECONDS, GROUP_SECONDS_MAX, GROUP_SECONDS_MIN, groupMaxSecondsOf } from '../../domain/rules/shot-group-rules';
import { capGroupSeconds, checkStoryboardTarget, describeTargetModel } from '../../domain/rules/storyboard-target-rules';
import { GenerationProfileService } from '../services/generation-profile-service';
import { ProjectService } from '../services/project-service';
import { ProviderService } from '../services/provider-service';
import { StoryboardService } from '../services/storyboard-service';
import { WorkService } from '../services/work-service';
import { AsyncFormFactory, FormCatalog, FormDefinition, FormFactory, FormValues } from './form-definition';
import { FormFieldSchema } from './form-schema';

/** 分镜脚本表单在表单目录中的名称，页面据此请求打开。 */
export const STORYBOARD_FORM_NAMES = {
  start: 'storyboard.start',
  pick: 'storyboard.pick'
} as const;

/** 分镜脚本表单依赖的服务与回调。 */
export interface StoryboardFormDependencies {
  readonly projects: ProjectService;
  readonly works: WorkService;
  readonly storyboards: StoryboardService;
  /** 作品默认生成参数：目标模型、画幅、分辨率的初始值与保存。 */
  readonly profiles: Pick<GenerationProfileService, 'getWorkDefaults' | 'saveWorkDefaults'>;
  /** 可用的视频模型，作为目标模型的选项。 */
  readonly providers: Pick<ProviderService, 'listUsableModels'>;
  /** 生成已开始后调用，参数为已启动的集；用于打开该集（多集时打开各集状态列表）的页面。 */
  readonly onStarted: (workId: number, episodeIds: readonly number[]) => void;
  /** “选择作品”表单提交后调用，用于打开该作品的生成表单。 */
  readonly onPicked: (workId: number) => void;
}

const SUBMIT_LABEL = '开始生成';
const PICK_SUBMIT_LABEL = '下一步';
const PICK_FIELD_KEY = 'work';
const PICK_SEPARATOR = ' › ';
const NO_STARTABLE_MESSAGE = '没有可生成分镜脚本的作品，请先在“剧本”列表中确认剧本。';
const PICK_REQUIRED_MESSAGE = '请选择所属作品。';
const EPISODE_REQUIRED_MESSAGE = '请至少选择一集。';
const MODEL_INVALID_MESSAGE = '请选择列表中的模型。';
/** 目标模型、画幅、分辨率的字段键：保存为作品默认，不属于分镜脚本的生成参数。 */
const TARGET_KEYS = { model: 'videoModel', aspectRatio: 'aspectRatio', resolution: 'resolution' } as const;
const SOUND_KINDS = Object.keys(SOUND_KIND_LABELS) as SoundKind[];

/** 生成参数转表单初始值：数字转为文本，未设置的项为空串，选项使用界面文字。 */
function paramsToValues(params: StoryboardParams): FormValues {
  return {
    visualStyle: params.visualStyle ?? '',
    minShotSeconds: params.minShotSeconds === null ? '' : String(params.minShotSeconds),
    maxShotSeconds: params.maxShotSeconds === null ? '' : String(params.maxShotSeconds),
    groupMaxSeconds: String(groupMaxSecondsOf(params)),
    maxShots: params.maxShots === null ? '' : String(params.maxShots),
    continuity: CONTINUITY_LABELS[params.continuity],
    audioMode: AUDIO_MODE_LABELS[params.audioMode],
    // 无声时没有记录声音内容，重新生成改回有声时默认全选。
    audioElements: JSON.stringify((params.audioElements.length === 0 ? SOUND_KINDS : params.audioElements).map((kind) => SOUND_KIND_LABELS[kind])),
    extra: params.extra ?? ''
  };
}

/** 没有上次参数时的初始值；单组最长时长默认值不超过目标模型的单次最长时长。 */
function defaultValues(groupMaxSeconds: number): FormValues {
  return {
    groupMaxSeconds: String(groupMaxSeconds),
    continuity: CONTINUITY_LABELS.ai,
    audioMode: AUDIO_MODE_LABELS.native,
    audioElements: JSON.stringify(SOUND_KINDS.map((kind) => SOUND_KIND_LABELS[kind]))
  };
}

/** 一个可选的目标视频模型：选项文字与能力。 */
interface TargetModelOption {
  readonly id: number;
  readonly label: string;
  readonly capability: VideoCapability;
}

/** 去掉目标模型、画幅、分辨率，剩下的才是分镜脚本的生成参数。 */
function withoutTargetValues(values: FormValues): FormValues {
  const rest: Record<string, string> = { ...values };
  for (const key of Object.values(TARGET_KEYS)) {
    delete rest[key];
  }
  return rest;
}

/** 合并各模型支持的取值，保持首次出现的顺序。 */
function mergeOptions(lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat())];
}

/**
 * 创建“生成分镜脚本”表单的定义。
 * @param episodeId 指定时只为这一集生成（重新生成、从某集进入）；缺省时多集作品可多选。
 */
async function createStartForm(dependencies: StoryboardFormDependencies, workId: number, episodeId: number | undefined): Promise<FormDefinition> {
  const { works, projects, storyboards, profiles, providers, onStarted } = dependencies;
  const work = works.getWork(workId);
  storyboards.assertCanStart(workId);
  const statuses = storyboards.listEpisodeStatuses(workId);
  if (episodeId !== undefined && !statuses.some((status) => status.episodeId === episodeId)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '集不存在。' });
  }
  const projectStyle = projects.getProject(work.projectId).visualStyle;
  // 这一集还没有生成过时，沿用作品里其他集最近一次的参数。
  const lastParams = storyboards.getLastParams(workId, episodeId) ?? storyboards.getLastParams(workId);

  const models: TargetModelOption[] = (await providers.listUsableModels('video')).map(({ model, providerName }) => ({
    id: model.id,
    label: describeTargetModel(providerName, model.displayName, model.capability as VideoCapability),
    capability: model.capability as VideoCapability
  }));
  const hasTargets = models.length > 0;
  const aspectRatios = mergeOptions(models.map((model) => model.capability.aspectRatios));
  const resolutions = mergeOptions(models.map((model) => model.capability.resolutions));
  const defaults = profiles.getWorkDefaults(workId).values;
  const defaultModel = models.find((model) => model.id === defaults.modelId);
  const targetValues: FormValues = hasTargets
    ? {
        [TARGET_KEYS.model]: defaultModel?.label ?? '',
        [TARGET_KEYS.aspectRatio]: defaults.aspectRatio !== null && aspectRatios.includes(defaults.aspectRatio) ? defaults.aspectRatio : '',
        [TARGET_KEYS.resolution]: defaults.resolution !== null && resolutions.includes(defaults.resolution) ? defaults.resolution : ''
      }
    : {};

  const episodeLabels = new Map(statuses.map((status) => [status.episodeId, `第 ${status.seq} 集 ${status.title}`]));
  // 只有一集（单个短视频）或已指定集时不需要选择。
  const needsEpisodeChoice = statuses.length > 1 && episodeId === undefined;
  const fields: FormFieldSchema[] = [];
  if (needsEpisodeChoice) {
    fields.push({
      key: 'episodes',
      label: '集',
      description: '可多选，一次为每个所选集各生成一份分镜脚本',
      control: 'checkboxes',
      required: true,
      options: [...episodeLabels.values()]
    });
  }
  if (hasTargets) {
    fields.push(
      {
        key: TARGET_KEYS.model,
        label: '目标视频模型',
        description: '可选；生成后用于出视频的模型，下面的画幅、分辨率与单组最长时长须在它的能力范围内。三项保存为本作品默认，工作台直接沿用（在工作台“生成参数”里单独覆盖过的集以覆盖值为准）',
        control: 'select',
        required: false,
        options: models.map((model) => model.label)
      },
      {
        key: TARGET_KEYS.aspectRatio,
        label: '画幅',
        description: '可选；留空沿用项目默认画幅，没有则由模型决定',
        control: 'select',
        required: false,
        options: aspectRatios
      },
      {
        key: TARGET_KEYS.resolution,
        label: '分辨率',
        description: '可选；留空沿用项目默认分辨率，没有则使用模型默认值',
        control: 'select',
        required: false,
        options: resolutions
      }
    );
  }
  fields.push(
    {
      key: 'visualStyle',
      label: '画面风格',
      description: projectStyle === null ? `可选；留空则不指定风格，也可选“其他”手动输入（最多 ${STORYBOARD_STYLE_MAX_LENGTH} 字）` : `可选；留空沿用项目视觉风格“${projectStyle}”，也可选“其他”手动输入（最多 ${STORYBOARD_STYLE_MAX_LENGTH} 字）`,
      control: 'select',
      required: false,
      maxLength: STORYBOARD_STYLE_MAX_LENGTH,
      options: VISUAL_STYLE_OPTIONS,
      allowCustom: true
    },
    {
      key: 'minShotSeconds',
      label: '单镜头最短时长（秒）',
      description: `可选，${SHOT_SECONDS_MIN} 至 ${SHOT_SECONDS_MAX}，最多 1 位小数`,
      control: 'text',
      required: false
    },
    {
      key: 'maxShotSeconds',
      label: '单镜头最长时长（秒）',
      description: '可选，不小于最短时长，且不大于单组最长时长；建议 4 到 6 秒',
      control: 'text',
      required: false
    },
    {
      key: 'groupMaxSeconds',
      label: '单组最长时长（秒）',
      description: `${GROUP_SECONDS_MIN} 至 ${GROUP_SECONDS_MAX} 的整数，默认 ${DEFAULT_GROUP_MAX_SECONDS}。相邻镜头会按顺序打包成组、一组一次生成一个视频，不能超过目标视频模型的单次最长时长（如 15、20、30 秒；选了目标模型时按它检查）`,
      control: 'text',
      required: false
    },
    {
      key: 'maxShots',
      label: '镜头总数上限',
      description: `可选，1 至 ${MAX_SHOTS_LIMIT}；内容不足时不会为达到上限而拆分`,
      control: 'text',
      required: false
    },
    {
      key: 'continuity',
      label: '镜头连贯策略',
      description: '无：镜头之间不衔接；尾帧接首帧：除第 1 个外都用上一镜头尾帧；由 AI 判断：逐个镜头决定',
      control: 'select',
      required: true,
      options: Object.values(CONTINUITY_LABELS)
    },
    {
      key: 'audioMode',
      label: '声音模式',
      description: '无声时不生成任何声音条目',
      control: 'select',
      required: true,
      options: Object.values(AUDIO_MODE_LABELS)
    },
    {
      key: 'audioElements',
      label: '声音内容',
      description: '决定生成哪些类型的声音条目；不勾选“角色对白”时，角色说的话不会生成，也就用不上角色绑定的音色；声音模式为无声时忽略',
      control: 'checkboxes',
      required: false,
      options: SOUND_KINDS.map((kind) => SOUND_KIND_LABELS[kind])
    },
    {
      key: 'extra',
      label: '补充要求',
      description: `可选，最多 ${STORYBOARD_EXTRA_MAX_LENGTH} 字；只写无法用上面字段表达的要求`,
      control: 'textarea',
      required: false,
      maxLength: STORYBOARD_EXTRA_MAX_LENGTH
    }
  );

  // 默认勾选还没有分镜脚本的集；都已生成过时勾选全部。
  const pending = statuses.filter((status) => status.display === 'none').map((status) => status.episodeId);
  const defaultEpisodes = (pending.length > 0 ? pending : [...episodeLabels.keys()]).map((id) => episodeLabels.get(id) ?? '');
  const title = episodeId === undefined ? `生成分镜脚本：${work.name}` : `生成分镜脚本：${work.name} › ${episodeLabels.get(episodeId) ?? ''}`;

  return {
    schema: { title, submitLabel: SUBMIT_LABEL, fields },
    initialValues: {
      ...(lastParams === undefined ? defaultValues(capGroupSeconds(DEFAULT_GROUP_MAX_SECONDS, defaultModel?.capability)) : paramsToValues(lastParams)),
      ...targetValues,
      ...(needsEpisodeChoice ? { episodes: JSON.stringify(defaultEpisodes) } : {})
    },
    submit: async (values) => {
      let ids: number[];
      if (needsEpisodeChoice) {
        const chosen = parseChosenLabels(values.episodes);
        ids = [...episodeLabels.entries()].filter(([, label]) => chosen.includes(label)).map(([id]) => id);
        if (ids.length === 0) {
          throw new ValidationError({ episodes: EPISODE_REQUIRED_MESSAGE });
        }
      } else {
        ids = episodeId === undefined ? [statuses[0].episodeId] : [episodeId];
      }
      const paramValues = withoutTargetValues(values);
      const changes = hasTargets ? readTargetChanges(values, targetValues, models, normalizeStoryboardParams(paramValues)) : {};
      // 画幅留空时由服务取项目默认画幅；没有可选模型时沿用作品默认。
      const aspectRatio = hasTargets ? values[TARGET_KEYS.aspectRatio] || null : defaults.aspectRatio;
      await storyboards.start(workId, ids, paramValues, aspectRatio);
      // 生成已启动后再保存默认参数，启动失败时不改动作品默认。
      if (Object.keys(changes).length > 0) {
        profiles.saveWorkDefaults(workId, changes);
      }
      onStarted(workId, ids);
    }
  };
}

/**
 * 检查目标模型、画幅、分辨率，并找出相对初始值有改动的项。
 * @returns 要保存到作品默认的修改；没有改动时为空对象。
 * @throws ValidationError 所选模型不在列表中，或所选模型不满足画幅、分辨率、单组最长时长。
 */
function readTargetChanges(values: FormValues, initial: FormValues, models: readonly TargetModelOption[], params: StoryboardParams): ProfileChanges {
  const modelLabel = values[TARGET_KEYS.model] ?? '';
  const aspectRatio = values[TARGET_KEYS.aspectRatio] ?? '';
  const resolution = values[TARGET_KEYS.resolution] ?? '';
  const chosen = models.find((model) => model.label === modelLabel);
  if (modelLabel !== '' && chosen === undefined) {
    throw new ValidationError({ [TARGET_KEYS.model]: MODEL_INVALID_MESSAGE });
  }
  if (chosen !== undefined) {
    assertNoFieldErrors(checkStoryboardTarget(chosen.capability, { aspectRatio, resolution, groupMaxSeconds: params.groupMaxSeconds }));
  }
  return {
    ...(modelLabel === initial[TARGET_KEYS.model] ? {} : { modelId: chosen?.id ?? null }),
    ...(aspectRatio === initial[TARGET_KEYS.aspectRatio] ? {} : { aspectRatio: aspectRatio === '' ? null : aspectRatio }),
    ...(resolution === initial[TARGET_KEYS.resolution] ? {} : { resolution: resolution === '' ? null : resolution })
  };
}

/** 读取表单传来的多选值（JSON 数组文本）；格式不对时按未选择处理。 */
function parseChosenLabels(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 创建“选择作品”表单的定义：只列剧本已确认的作品，选项标签为“项目 › 作品”。
 * @param projectId 限定在该项目内选择；缺省列出全部项目。
 */
function createPickForm(dependencies: StoryboardFormDependencies, projectId: number | undefined): FormDefinition {
  const { projects, works, storyboards, onPicked } = dependencies;
  const names = new Map(projects.listProjects().map((project) => [project.id, project.name]));
  const candidates = works
    .listAllWorks()
    .filter((work) => (projectId === undefined || work.projectId === projectId) && storyboards.getSummary(work.id).canStart)
    .map((work) => ({ id: work.id, label: `${names.get(work.projectId) ?? ''}${PICK_SEPARATOR}${work.name}` }));
  if (candidates.length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_STARTABLE_MESSAGE });
  }
  const field: FormFieldSchema = {
    key: PICK_FIELD_KEY,
    label: '所属作品',
    description: '只列出剧本已确认的作品',
    control: 'select',
    required: true,
    options: candidates.map((candidate) => candidate.label)
  };
  return {
    schema: { title: '生成分镜脚本', submitLabel: PICK_SUBMIT_LABEL, fields: [field] },
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
 * 创建分镜脚本表单目录：`storyboard.start` 的参数为 `{ workId, episodeId? }`，`storyboard.pick` 的参数为 `{ projectId? }`。
 * @param dependencies 服务与回调。
 */
export function createStoryboardFormCatalog(dependencies: StoryboardFormDependencies): FormCatalog {
  return new Map<string, FormFactory | AsyncFormFactory>([
    [
      STORYBOARD_FORM_NAMES.start,
      (params) => {
        const source = readRecord(params);
        const episodeId = source.episodeId === undefined ? undefined : readEntityId({ id: source.episodeId }, '集');
        return createStartForm(dependencies, readEntityId({ id: source.workId }, '作品'), episodeId);
      }
    ],
    [
      STORYBOARD_FORM_NAMES.pick,
      (params) => {
        const projectId = readRecord(params ?? {}).projectId;
        return createPickForm(dependencies, typeof projectId === 'number' ? projectId : undefined);
      }
    ]
  ]);
}
