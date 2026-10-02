// ------------------------------------------------------------------------
// 名称：asset-form.ts
// 说明：资产表单（F6）的定义：新建与编辑角色、场景、道具、特效、音频资产；字段、选项与上传限制随类型变化。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：类型由入口决定、创建后不能修改；新建时在表单里选择所属项目（入口可传默认项目），编辑时不显示项目；字段约束取自领域规则常量，保证界面与宿主校验一致；表单引擎不支持字段联动和折叠，风格留空表示沿用项目风格，语言仅对音色参考有效；提交按钮区分“仅保存”与“保存并生成提示词”，后者在保存后启动后台提示词生成；从实体新建（参数带 episodeId、entityId）时按实体设定预填、项目固定为作品所在项目，保存后自动绑定为形象。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import {
  ASSET_ATTRIBUTE_FIELDS,
  ASSET_KINDS,
  ASSET_KIND_LABELS,
  AUDIO_KIND_LABELS,
  AssetFileRecord,
  AssetKind,
  AssetRecord,
  AudioKind
} from '../../domain/models/asset';
import { BindingEntityDetail } from '../../domain/models/binding';
import { ASSET_OPTION_SETS, AUDIO_LANGUAGE_OPTIONS, CHARACTER_TYPE_OPTIONS } from '../../domain/models/option-sets';
import {
  ASSET_ATTRIBUTE_MAX_LENGTH,
  ASSET_AUDIO_EXTENSIONS,
  ASSET_AUDIO_MAX_BYTES,
  ASSET_AUDIO_MAX_SECONDS,
  ASSET_CHOICE_MAX_LENGTH,
  ASSET_EXTRA_MAX_LENGTH,
  ASSET_FILE_FIELD_KEY,
  ASSET_IMAGE_EXTENSIONS,
  ASSET_IMAGE_MAX_BYTES,
  ASSET_IMAGE_MAX_FILES,
  ASSET_NAME_MAX_LENGTH,
  ASSET_PROMPT_MAX_LENGTH,
  ASSET_STYLE_MAX_LENGTH
} from '../../domain/rules/asset-rules';
import { buildAssetPrefill } from '../../domain/rules/entity-asset-prefill';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { ASSET_PROJECT_FIELD_KEY, AssetService, DUPLICATE_ASSET_NAME_MESSAGE } from '../services/asset-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { ProjectService } from '../services/project-service';
import { FormCatalog, FormDefinition, FormFactory, FormValues } from './form-definition';
import { FormFieldSchema, FormSubmitActionSchema } from './form-schema';

/** 资产表单在表单目录中的名称，页面据此请求打开。 */
export const ASSET_FORM_NAMES = {
  create: 'asset.create',
  edit: 'asset.edit'
} as const;

/** 提交按钮的键：仅创建、创建并生成提示词、保存、保存并重新生成提示词。 */
export const ASSET_SUBMIT_KEYS = {
  create: 'create',
  createAndPrompt: 'createAndPrompt',
  save: 'save',
  saveAndPrompt: 'saveAndPrompt'
} as const;

const NO_PROJECT_MESSAGE = '还没有项目，请先在“所有项目”中创建项目。';
const PROMPT_RUNNING_MESSAGE = '提示词正在生成中，完成后再重新生成。';
const MEGABYTE = 1024 * 1024;
const PROMPT_MAX_ROWS = 6;
/** 参考图以外的长文本描述最多长到的行数。 */
const ATTRIBUTE_MAX_ROWS = 4;
/** 提示词字段的键。 */
const PROMPT_FIELD_KEYS = ['promptZh', 'promptEn'] as const;

/** 新建表单的提交按钮：仅创建，或创建后在后台生成提示词（主按钮）。 */
const CREATE_SUBMIT_ACTIONS: readonly FormSubmitActionSchema[] = [
  { key: ASSET_SUBMIT_KEYS.create, label: '仅创建' },
  { key: ASSET_SUBMIT_KEYS.createAndPrompt, label: '创建并生成提示词', primary: true }
];

/** 编辑表单的提交按钮：仅保存，或保存后重新生成提示词（主按钮，提示词已有内容时先确认覆盖）。 */
const EDIT_SUBMIT_ACTIONS: readonly FormSubmitActionSchema[] = [
  { key: ASSET_SUBMIT_KEYS.save, label: '保存' },
  {
    key: ASSET_SUBMIT_KEYS.saveAndPrompt,
    label: '保存并重新生成提示词',
    primary: true,
    confirmOverwrite: { fields: PROMPT_FIELD_KEYS, title: '覆盖现有提示词', message: '将用重新生成的提示词覆盖现有提示词，确定吗？', confirmText: '覆盖' }
  }
];

/** 入口传来的资产类型，必须是五种之一。 */
function readKind(value: unknown): AssetKind {
  if (typeof value !== 'string' || !ASSET_KINDS.includes(value as AssetKind)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '资产类型无效。' });
  }
  return value as AssetKind;
}

/** 所属项目字段：值为项目名称。 */
function createProjectField(projectNames: readonly string[]): FormFieldSchema {
  return {
    key: ASSET_PROJECT_FIELD_KEY,
    label: '所属项目',
    description: '资产所属的项目，创建后不能更改',
    control: 'select',
    required: true,
    options: projectNames
  };
}

/** 资产名称字段；新建时所属项目还没确定，不能在失去焦点时检查重名，由提交时校验。 */
function createNameField(kind: AssetKind, checkUnique: boolean): FormFieldSchema {
  const label = ASSET_KIND_LABELS[kind];
  return {
    key: 'name',
    label: `${label}名称`,
    description: `${label}在项目内的唯一名称，最多 ${ASSET_NAME_MAX_LENGTH} 字`,
    control: 'text',
    required: true,
    maxLength: ASSET_NAME_MAX_LENGTH,
    checkUnique
  };
}

/** 补充要求字段。 */
function createExtraField(): FormFieldSchema {
  return {
    key: 'extra',
    label: '补充要求',
    description: `其他需要说明的要求，最多 ${ASSET_EXTRA_MAX_LENGTH} 字`,
    control: 'textarea',
    required: false,
    maxLength: ASSET_EXTRA_MAX_LENGTH
  };
}

/** 中英文提示词字段；提示词生成中只读。 */
function createPromptFields(kind: AssetKind, promptLocked: boolean): FormFieldSchema[] {
  const purpose = kind === 'audio' ? '音频生成提示词' : '图像生成提示词';
  const note = promptLocked ? '提示词生成中，完成后再修改' : `${purpose}，可手动编辑，最多 ${ASSET_PROMPT_MAX_LENGTH} 字`;
  return [
    { key: 'promptZh', label: '中文提示词', description: note, control: 'textarea', required: false, maxLength: ASSET_PROMPT_MAX_LENGTH, maxRows: PROMPT_MAX_ROWS, disabled: promptLocked },
    { key: 'promptEn', label: '英文提示词', description: note, control: 'textarea', required: false, maxLength: ASSET_PROMPT_MAX_LENGTH, maxRows: PROMPT_MAX_ROWS, disabled: promptLocked }
  ];
}

/** 图像类资产（角色、场景、道具、特效）的字段。 */
function createImageFields(kind: Exclude<AssetKind, 'audio'>, promptLocked: boolean): FormFieldSchema[] {
  const options = ASSET_OPTION_SETS[kind];
  const fields: FormFieldSchema[] = [
    {
      key: 'composition',
      label: '视角与构图',
      description: '可从预置项选择，也可选“其他”手动输入',
      control: 'select',
      required: false,
      maxLength: ASSET_CHOICE_MAX_LENGTH,
      options: options.composition,
      allowCustom: true
    },
    {
      key: 'style',
      label: '画面风格',
      description: `留空表示沿用项目的视觉风格；也可选“其他”手动输入（最多 ${ASSET_STYLE_MAX_LENGTH} 字）`,
      control: 'select',
      required: false,
      maxLength: ASSET_STYLE_MAX_LENGTH,
      options: options.style,
      allowCustom: true
    },
    {
      key: 'background',
      label: '背景',
      description: '可从预置项选择，也可选“其他”手动输入',
      control: 'select',
      required: false,
      maxLength: ASSET_CHOICE_MAX_LENGTH,
      options: options.background,
      allowCustom: true
    },
    {
      key: 'referenceAspectRatio',
      label: '参考图画幅',
      description: '仅表示参考图的尺寸比例，与视频画幅无关',
      control: 'select',
      required: false,
      options: options.aspectRatio
    },
    ...ASSET_ATTRIBUTE_FIELDS[kind].map(
      (field): FormFieldSchema =>
        field.key === 'character_type'
          ? {
              key: field.formKey,
              label: field.label,
              description: '可从预置项选择，也可选“其他”手动输入',
              control: 'select',
              required: false,
              maxLength: ASSET_CHOICE_MAX_LENGTH,
              options: CHARACTER_TYPE_OPTIONS,
              allowCustom: true
            }
          : {
              key: field.formKey,
              label: field.label,
              description: field.key === 'voice_description' ? '描述音色、年龄感、语速、情绪特点，如“低沉沙哑的中年男声，语速偏慢”' : `最多 ${ASSET_ATTRIBUTE_MAX_LENGTH} 字`,
              control: 'textarea',
              required: false,
              maxLength: ASSET_ATTRIBUTE_MAX_LENGTH,
              maxRows: ATTRIBUTE_MAX_ROWS
            }
    ),
    createExtraField(),
    ...createPromptFields(kind, promptLocked),
    {
      key: ASSET_FILE_FIELD_KEY,
      label: '参考图',
      description: `最多 ${ASSET_IMAGE_MAX_FILES} 张；PNG、JPEG、WebP，每张不超过 ${ASSET_IMAGE_MAX_BYTES / MEGABYTE} MB，点击缩略图查看原图，可调整顺序；保存时自动生成缩略图`,
      control: 'file',
      required: false,
      accept: ASSET_IMAGE_EXTENSIONS,
      multiple: true,
      maxFiles: ASSET_IMAGE_MAX_FILES,
      maxFileBytes: ASSET_IMAGE_MAX_BYTES,
      preview: 'image',
      derive: 'image'
    }
  ];
  return fields;
}

/** 音频资产的字段；音频文件可以暂时为空（之后上传或由模型生成）。 */
function createAudioFields(promptLocked: boolean): FormFieldSchema[] {
  return [
    {
      key: 'audioKind',
      label: '音频类型',
      description: '被绑定或引用后不能再修改',
      control: 'radio',
      required: true,
      options: Object.values(AUDIO_KIND_LABELS)
    },
    {
      key: 'description',
      label: '描述',
      description: `描述风格、情绪或适用场景，最多 ${ASSET_ATTRIBUTE_MAX_LENGTH} 字`,
      control: 'textarea',
      required: false,
      maxLength: ASSET_ATTRIBUTE_MAX_LENGTH,
      maxRows: ATTRIBUTE_MAX_ROWS
    },
    {
      key: 'language',
      label: '语言',
      description: '仅对“音色参考”有效，其他类型会忽略',
      control: 'select',
      required: false,
      options: AUDIO_LANGUAGE_OPTIONS
    },
    createExtraField(),
    ...createPromptFields('audio', promptLocked),
    {
      key: ASSET_FILE_FIELD_KEY,
      label: '音频文件',
      description: `可选，也可以之后由音频模型生成；MP3、WAV、M4A，不超过 ${ASSET_AUDIO_MAX_BYTES / MEGABYTE} MB，时长不超过 ${ASSET_AUDIO_MAX_SECONDS} 秒；保存时读取时长，无法解码的文件会提示`,
      control: 'file',
      required: false,
      accept: ASSET_AUDIO_EXTENSIONS,
      multiple: false,
      maxFileBytes: ASSET_AUDIO_MAX_BYTES,
      derive: 'audio'
    }
  ];
}

/** 按类型组装表单字段；新建时带所属项目。 */
function createFields(
  kind: AssetKind,
  projectNames: readonly string[] | undefined,
  checkUnique: boolean,
  promptLocked = false
): FormFieldSchema[] {
  return [
    ...(projectNames === undefined ? [] : [createProjectField(projectNames)]),
    createNameField(kind, checkUnique),
    ...(kind === 'audio' ? createAudioFields(promptLocked) : createImageFields(kind, promptLocked))
  ];
}

/** 已保存的参考文件转文件字段的初始值（与界面提交的格式一致：JSON 文本，Base64 内容）。 */
function filesToValue(files: readonly AssetFileRecord[]): string {
  return JSON.stringify(
    files.map((file) => ({ name: file.fileName, mimeType: file.mime, size: file.content.length, data: file.content.toString('base64') }))
  );
}

/** 资产转表单初始值：未设置的选项为空串。 */
function toFormValues(asset: AssetRecord, files: readonly AssetFileRecord[]): FormValues {
  const values: Record<string, string> = {
    name: asset.name,
    extra: asset.extraRequirements,
    promptZh: asset.promptZh,
    promptEn: asset.promptEn,
    [ASSET_FILE_FIELD_KEY]: filesToValue(files)
  };
  if (asset.kind === 'audio') {
    const audioKind = asset.attributes.audio_kind as AudioKind | undefined;
    values.audioKind = audioKind === undefined ? '' : AUDIO_KIND_LABELS[audioKind];
    values.description = asset.attributes.description ?? '';
    values.language = asset.attributes.language ?? '';
    return values;
  }
  values.composition = asset.composition;
  values.style = asset.style ?? '';
  values.background = asset.background;
  values.referenceAspectRatio = asset.referenceAspectRatio ?? '';
  for (const field of ASSET_ATTRIBUTE_FIELDS[asset.kind]) {
    values[field.formKey] = asset.attributes[field.key] ?? '';
  }
  return values;
}

/** 提交内容里是否带有参考图（文件字段不是空数组）。 */
function hasFiles(values: FormValues): boolean {
  try {
    const parsed: unknown = JSON.parse(values[ASSET_FILE_FIELD_KEY] || '[]');
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** 新建资产表单依赖的服务。 */
export interface AssetFormDependencies {
  readonly projects: ProjectService;
  readonly assets: AssetService;
  readonly prompts: AssetPromptService;
  /** 从实体新建资产时读取实体设定并绑定；不支持从实体新建的页面可以不传。 */
  readonly entities?: AssetEntitySource;
}

/** 从实体新建资产需要的能力：读取实体设定、把新资产绑定到实体（BindingService 实现）。 */
export interface AssetEntitySource {
  getEntityDetail(episodeId: number, entityId: number): BindingEntityDetail;
  bind(rawInput: unknown): unknown;
}

/**
 * 创建“新建资产”表单的定义。
 * @param params `{ kind, projectId? }`，projectId 为入口筛选的项目，作为所属项目的默认值；或 `{ episodeId, entityId }`，从实体预填并在保存后绑定。
 */
function createNewAssetForm(dependencies: AssetFormDependencies, params: unknown): FormDefinition {
  const source = readRecord(params ?? {});
  if (source.entityId !== undefined) {
    return createEntityAssetForm(dependencies, source);
  }
  const { projects, assets, prompts } = dependencies;
  const kind = readKind(source.kind);
  const summaries = projects.listProjects();
  if (summaries.length === 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_PROJECT_MESSAGE });
  }
  const preset = typeof source.projectId === 'number' ? summaries.find((project) => project.id === source.projectId) : undefined;
  const defaultProject = preset ?? (summaries.length === 1 ? summaries[0] : undefined);
  return {
    schema: {
      title: `新建${ASSET_KIND_LABELS[kind]}`,
      submitLabel: CREATE_SUBMIT_ACTIONS[1].label,
      fields: createFields(kind, summaries.map((project) => project.name), false),
      submitActions: CREATE_SUBMIT_ACTIONS
    },
    initialValues: {
      ...(defaultProject === undefined ? {} : { [ASSET_PROJECT_FIELD_KEY]: defaultProject.name }),
      ...(kind === 'audio' ? { audioKind: AUDIO_KIND_LABELS.voice } : {})
    },
    submit: (values, submitKey) => {
      // 先检查信息是否足够生成提示词，避免保存了资产却无法生成。
      const generate = submitKey === ASSET_SUBMIT_KEYS.createAndPrompt;
      if (generate) {
        prompts.assertCanGenerate(kind, values, hasFiles(values));
      }
      const asset = assets.createAsset(kind, values);
      if (generate) {
        prompts.start(asset.id);
      }
    }
  };
}

/**
 * 创建“从实体新建资产”表单的定义：类型与实体相同，所属项目固定为作品所在项目（否则无法绑定），保存后绑定为该实体的形象。
 * @param source `{ episodeId, entityId }`。
 */
function createEntityAssetForm(dependencies: AssetFormDependencies, source: Record<string, unknown>): FormDefinition {
  const { projects, assets, entities } = dependencies;
  if (entities === undefined) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '当前页面不支持从实体新建资产。' });
  }
  const episodeId = readEntityId({ id: source.episodeId }, '集');
  const entityId = readEntityId({ id: source.entityId }, '实体');
  const entity = entities.getEntityDetail(episodeId, entityId);
  const project = projects.getProject(entity.projectId);
  const kind: AssetKind = entity.kind;
  return {
    schema: {
      title: `新建${ASSET_KIND_LABELS[kind]}`,
      submitLabel: CREATE_SUBMIT_ACTIONS[1].label,
      fields: createFields(kind, [project.name], false),
      submitActions: CREATE_SUBMIT_ACTIONS
    },
    initialValues: { ...buildAssetPrefill(entity), [ASSET_PROJECT_FIELD_KEY]: project.name },
    submit: (values, submitKey) => {
      const generate = submitKey === ASSET_SUBMIT_KEYS.createAndPrompt;
      if (generate) {
        dependencies.prompts.assertCanGenerate(kind, values, hasFiles(values));
      }
      const asset = assets.createAsset(kind, values, { sourceEntityId: entityId });
      try {
        entities.bind({ episodeId, entityId, assetId: asset.id, purpose: 'visual' });
      } catch (error) {
        // 绑定失败时不留下未绑定的新资产，用户重新保存不会因重名被拒绝。
        assets.deleteAsset(asset.id);
        throw error;
      }
      if (generate) {
        dependencies.prompts.start(asset.id);
      }
    }
  };
}

/** 创建“编辑资产”表单的定义；所属项目与类型不能修改，因此不显示项目字段。 */
function createEditAssetForm(assets: AssetService, prompts: AssetPromptService, assetId: number): FormDefinition {
  const asset = assets.getAsset(assetId);
  const promptLocked = asset.promptStatus === 'running';
  return {
    schema: {
      title: `编辑${ASSET_KIND_LABELS[asset.kind]}`,
      submitLabel: EDIT_SUBMIT_ACTIONS[1].label,
      fields: createFields(asset.kind, undefined, true, promptLocked),
      submitActions: EDIT_SUBMIT_ACTIONS
    },
    initialValues: toFormValues(asset, assets.getReferenceFiles(assetId)),
    checkField: (key, value) =>
      key === 'name' && !assets.isNameAvailable(asset.projectId, asset.kind, value, asset.id) ? DUPLICATE_ASSET_NAME_MESSAGE : undefined,
    submit: (values, submitKey) => {
      const regenerate = submitKey === ASSET_SUBMIT_KEYS.saveAndPrompt;
      const current = assets.getAsset(asset.id);
      if (regenerate) {
        if (current.promptStatus === 'running') {
          throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: PROMPT_RUNNING_MESSAGE });
        }
        prompts.assertCanGenerate(asset.kind, values, hasFiles(values));
      }
      // 打开表单时提示词正在生成：提示词字段是只读的，保存时保留库里最新的内容，不拿打开时的旧值覆盖生成结果。
      const submitted = promptLocked ? { ...values, promptZh: current.promptZh, promptEn: current.promptEn } : values;
      assets.updateAsset(asset.id, submitted);
      if (regenerate) {
        prompts.start(asset.id);
      }
    }
  };
}

/**
 * 创建资产表单目录：新建的参数为 `{ kind, projectId? }` 或 `{ episodeId, entityId }`（从实体新建），编辑的参数为 `{ assetId }`。
 * @param dependencies 项目、资产与提示词生成服务，以及可选的实体来源。
 */
export function createAssetFormCatalog(dependencies: AssetFormDependencies): FormCatalog {
  return new Map<string, FormFactory>([
    [ASSET_FORM_NAMES.create, (params) => createNewAssetForm(dependencies, params)],
    [
      ASSET_FORM_NAMES.edit,
      (params) =>
        createEditAssetForm(
          dependencies.assets,
          dependencies.prompts,
          readEntityId({ id: readRecord(params ?? {}).assetId }, '资产')
        )
    ]
  ]);
}
