// ------------------------------------------------------------------------
// 名称：asset-form.ts
// 说明：资产表单（F6）的定义：新建与编辑角色、场景、道具、特效、音频资产；字段、选项与上传限制随类型和文件来源（上传、生成）变化；同一目录还登记提示词表单（F14，见 asset-prompt-form.ts）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：类型由入口决定、创建后不能修改，资产不属于项目；文件来源由入口参数 fileSource 决定（缺省为生成）：上传表单只有名称、分类、必填的文件（音频另有类型、描述、语言），没有提示词按钮；生成表单没有文件字段；编辑时可用 fileSource=upload 打开上传表单，保存后资产改用上传；字段约束取自领域规则常量，保证界面与宿主校验一致；表单引擎不支持字段联动和折叠，风格留空表示不指定风格，语言仅对音色参考有效；“所属分类”是下拉，选项为该类型已有的分类名称，不选（空串）表示不分类，提交时由分类服务解析为分类标识（null 为不分类）；提交按钮区分“仅保存”与“保存并生成提示词”，后者在保存后启动后台提示词生成；从实体新建（参数带 episodeId、entityId）时按实体设定预填，画面风格预填为作品所在项目的视觉风格，保存后自动绑定为形象。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import {
  ASSET_ATTRIBUTE_FIELDS,
  ASSET_KIND_LABELS,
  AUDIO_KIND_LABELS,
  AssetFileRecord,
  AssetFileSource,
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
  ASSET_STYLE_MAX_LENGTH,
  readAssetKind
} from '../../domain/rules/asset-rules';
import { buildAssetPrefill } from '../../domain/rules/entity-asset-prefill';
import { hasPrompt } from '../../domain/rules/asset-generation-rules';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { AssetService, DUPLICATE_ASSET_NAME_MESSAGE } from '../services/asset-service';
import { ASSET_CATEGORY_FIELD_KEY, AssetCategoryService } from '../services/asset-category-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { ProjectService } from '../services/project-service';
import { SyncFormCatalog, FormDefinition, FormFactory, FormValues } from './form-definition';
import { FormFieldSchema, FormSubmitActionSchema } from './form-schema';
import { ASSET_PROMPT_FORM_NAME, createAssetPromptForm } from './asset-prompt-form';

/** 资产表单在表单目录中的名称，页面据此请求打开。 */
export const ASSET_FORM_NAMES = {
  create: 'asset.create',
  edit: 'asset.edit',
  prompt: ASSET_PROMPT_FORM_NAME
} as const;

/** 提交按钮的键：仅创建、创建并生成提示词、保存、保存并重新生成提示词。 */
export const ASSET_SUBMIT_KEYS = {
  create: 'create',
  createAndPrompt: 'createAndPrompt',
  save: 'save',
  saveAndPrompt: 'saveAndPrompt'
} as const;

const PROMPT_RUNNING_MESSAGE = '提示词正在生成中，完成后再重新生成。';
const MEGABYTE = 1024 * 1024;
/** 参考图以外的长文本描述最多长到的行数。 */
const ATTRIBUTE_MAX_ROWS = 4;

/** 所属分类下拉里表示“不分类”的文字：选项为空值时显示，提交的值为空串。 */
const NO_CATEGORY_LABEL = '不分类';

/** 上传来源表单的提交按钮文字：只有一个按钮，没有提示词。 */
const UPLOAD_SUBMIT_LABELS = { create: '创建', save: '保存' } as const;

/** 新建表单的提交按钮：仅创建，或创建后在后台生成提示词（主按钮）。 */
const CREATE_SUBMIT_ACTIONS: readonly FormSubmitActionSchema[] = [
  { key: ASSET_SUBMIT_KEYS.create, label: '仅创建' },
  { key: ASSET_SUBMIT_KEYS.createAndPrompt, label: '创建并生成提示词', primary: true }
];

/** 编辑表单的提交按钮：仅保存，或保存后重新生成提示词（主按钮；资产已有提示词时先确认覆盖）。 */
function createEditSubmitActions(hasExistingPrompt: boolean): FormSubmitActionSchema[] {
  return [
    { key: ASSET_SUBMIT_KEYS.save, label: '保存' },
    {
      key: ASSET_SUBMIT_KEYS.saveAndPrompt,
      label: '保存并重新生成提示词',
      primary: true,
      ...(hasExistingPrompt
        ? { confirmOverwrite: { fields: [], title: '覆盖现有提示词', message: '将用重新生成的提示词覆盖现有提示词，确定吗？', confirmText: '覆盖' } }
        : {})
    }
  ];
}

/** 所属分类字段：选项为该类型已有的分类名称，不选即不分类。 */
function createCategoryField(kind: AssetKind, categoryNames: readonly string[]): FormFieldSchema {
  return {
    key: ASSET_CATEGORY_FIELD_KEY,
    label: '所属分类',
    description: `默认不分类；${ASSET_KIND_LABELS[kind]}分类可在列表页的“分类管理”中创建`,
    control: 'select',
    required: false,
    options: categoryNames,
    placeholder: NO_CATEGORY_LABEL
  };
}

/** 资产名称字段。 */
function createNameField(kind: AssetKind): FormFieldSchema {
  const label = ASSET_KIND_LABELS[kind];
  return {
    key: 'name',
    label: `${label}名称`,
    description: `${label}的唯一名称，所有项目共用，最多 ${ASSET_NAME_MAX_LENGTH} 字`,
    control: 'text',
    required: true,
    maxLength: ASSET_NAME_MAX_LENGTH,
    checkUnique: true
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

/** 图像类资产（角色、场景、道具、特效）的字段。 */
function createImageFields(kind: Exclude<AssetKind, 'audio'>): FormFieldSchema[] {
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
      description: `留空表示不指定风格；也可选“其他”手动输入（最多 ${ASSET_STYLE_MAX_LENGTH} 字）`,
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
    createExtraField()
  ];
  return fields;
}

/** 上传来源的图片字段：参考图，至少 1 张。 */
function createImageFileField(): FormFieldSchema {
  return {
    key: ASSET_FILE_FIELD_KEY,
    label: '参考图',
    description: `至少 1 张，最多 ${ASSET_IMAGE_MAX_FILES} 张；PNG、JPEG、WebP，每张不超过 ${ASSET_IMAGE_MAX_BYTES / MEGABYTE} MB，点击缩略图查看原图，可调整顺序；保存时自动生成缩略图`,
    control: 'file',
    required: true,
    accept: ASSET_IMAGE_EXTENSIONS,
    multiple: true,
    maxFiles: ASSET_IMAGE_MAX_FILES,
    maxFileBytes: ASSET_IMAGE_MAX_BYTES,
    preview: 'image',
    derive: 'image'
  };
}

/** 上传来源的音频字段：音频文件，必须有 1 个。 */
function createAudioFileField(): FormFieldSchema {
  return {
    key: ASSET_FILE_FIELD_KEY,
    label: '音频文件',
    description: `MP3、WAV、M4A，不超过 ${ASSET_AUDIO_MAX_BYTES / MEGABYTE} MB，时长不超过 ${ASSET_AUDIO_MAX_SECONDS} 秒；保存时读取时长，无法解码的文件会提示`,
    control: 'file',
    required: true,
    accept: ASSET_AUDIO_EXTENSIONS,
    multiple: false,
    maxFileBytes: ASSET_AUDIO_MAX_BYTES,
    derive: 'audio'
  };
}

/** 音频类型字段。 */
function createAudioKindField(): FormFieldSchema {
  return {
    key: 'audioKind',
    label: '音频类型',
    description: '被绑定或引用后不能再修改',
    control: 'radio',
    required: true,
    options: Object.values(AUDIO_KIND_LABELS)
  };
}

/** 音频描述字段。 */
function createAudioDescriptionField(): FormFieldSchema {
  return {
    key: 'description',
    label: '描述',
    description: `描述风格、情绪或适用场景，最多 ${ASSET_ATTRIBUTE_MAX_LENGTH} 字`,
    control: 'textarea',
    required: false,
    maxLength: ASSET_ATTRIBUTE_MAX_LENGTH,
    maxRows: ATTRIBUTE_MAX_ROWS
  };
}

/** 音频语言字段。 */
function createAudioLanguageField(): FormFieldSchema {
  return {
    key: 'language',
    label: '语言',
    description: '仅对“音色参考”有效，其他类型会忽略',
    control: 'select',
    required: false,
    options: AUDIO_LANGUAGE_OPTIONS
  };
}

/** 生成来源的音频字段。 */
function createAudioFields(): FormFieldSchema[] {
  return [createAudioKindField(), createAudioDescriptionField(), createAudioLanguageField(), createExtraField()];
}

/** 上传来源的字段：图片资产只有参考图，音频资产是类型、描述、语言和音频文件。 */
function createUploadFields(kind: AssetKind): FormFieldSchema[] {
  return kind === 'audio'
    ? [createAudioKindField(), createAudioDescriptionField(), createAudioLanguageField(), createAudioFileField()]
    : [createImageFileField()];
}

/** 按类型和文件来源组装表单字段：名称之后是所属分类，选项取自该类型当前的分类。 */
function createFields(kind: AssetKind, categories: AssetCategoryService, fileSource: AssetFileSource): FormFieldSchema[] {
  const categoryNames = categories.listCategories(kind).map((category) => category.name);
  const sourceFields = fileSource === 'upload' ? createUploadFields(kind) : kind === 'audio' ? createAudioFields() : createImageFields(kind);
  return [createNameField(kind), createCategoryField(kind, categoryNames), ...sourceFields];
}

/** 读取表单参数里的文件来源：只接受 upload、generated，不传返回 undefined。 */
function readOptionalFileSource(value: unknown): AssetFileSource | undefined {
  if (value === undefined || value === 'generated' || value === 'upload') {
    return value;
  }
  throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '文件来源无效。' });
}

/** 读取新建表单参数里的文件来源：缺省为生成。 */
function readFileSource(value: unknown): AssetFileSource {
  return readOptionalFileSource(value) ?? 'generated';
}

/** 已保存的上传文件转文件字段的初始值（与界面提交的格式一致：JSON 文本，Base64 内容）。 */
function filesToValue(files: readonly AssetFileRecord[]): string {
  return JSON.stringify(
    files.map((file) => ({ name: file.fileName, mimeType: file.mime, size: file.content.length, data: file.content.toString('base64') }))
  );
}

/** 资产转表单初始值：未设置的选项为空串；上传来源的表单带上已上传的文件，生成来源的表单没有文件字段。 */
function toFormValues(asset: AssetRecord, fileSource: AssetFileSource, uploadFiles: readonly AssetFileRecord[]): FormValues {
  const values: Record<string, string> = { name: asset.name, extra: asset.extraRequirements };
  if (fileSource === 'upload') {
    values[ASSET_FILE_FIELD_KEY] = filesToValue(uploadFiles);
  }
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

/** 上传来源表单的标题：音频叫“上传音频”，其余叫“上传角色图片”等。 */
function createUploadTitle(kind: AssetKind): string {
  return kind === 'audio' ? '上传音频' : `上传${ASSET_KIND_LABELS[kind]}图片`;
}

/** 新建资产表单依赖的服务。 */
export interface AssetFormDependencies {
  /** 从实体新建时读取项目的视觉风格。 */
  readonly projects: ProjectService;
  readonly assets: AssetService;
  readonly prompts: AssetPromptService;
  /** 读取所属分类的选项，并把表单选择的分类名称解析为分类标识。 */
  readonly categories: AssetCategoryService;
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
 * @param params `{ kind, fileSource? }`（fileSource 为 upload 打开上传表单，缺省为生成）；或 `{ episodeId, entityId }`，从实体预填并在保存后绑定。
 */
function createNewAssetForm(dependencies: AssetFormDependencies, params: unknown): FormDefinition {
  const source = readRecord(params ?? {});
  if (source.entityId !== undefined) {
    return createEntityAssetForm(dependencies, source);
  }
  const { assets, prompts, categories } = dependencies;
  const kind = readAssetKind(source.kind);
  const fileSource = readFileSource(source.fileSource);
  const isUpload = fileSource === 'upload';
  return {
    schema: {
      title: isUpload ? createUploadTitle(kind) : `新建${ASSET_KIND_LABELS[kind]}`,
      submitLabel: isUpload ? UPLOAD_SUBMIT_LABELS.create : CREATE_SUBMIT_ACTIONS[1].label,
      fields: createFields(kind, categories, fileSource),
      ...(isUpload ? {} : { submitActions: CREATE_SUBMIT_ACTIONS })
    },
    initialValues: kind === 'audio' ? { audioKind: AUDIO_KIND_LABELS.voice } : {},
    checkField: (key, value) => (key === 'name' && !assets.isNameAvailable(kind, value) ? DUPLICATE_ASSET_NAME_MESSAGE : undefined),
    submit: (values, submitKey) => {
      // 先解析所属分类、检查信息是否足够生成提示词，避免保存了资产却无法生成。
      const categoryId = categories.resolveCategoryId(kind, values[ASSET_CATEGORY_FIELD_KEY] ?? '');
      const generate = submitKey === ASSET_SUBMIT_KEYS.createAndPrompt;
      if (generate) {
        prompts.assertCanGenerate(kind, values, false);
      }
      const asset = assets.createAsset(kind, values, { categoryId, fileSource });
      if (generate) {
        prompts.start(asset.id);
      }
    }
  };
}

/**
 * 创建“从实体新建资产”表单的定义：类型与实体相同，画面风格预填为作品所在项目的视觉风格，保存后绑定为该实体的形象。
 * @param source `{ episodeId, entityId }`。
 */
function createEntityAssetForm(dependencies: AssetFormDependencies, source: Record<string, unknown>): FormDefinition {
  const { projects, assets, categories, entities } = dependencies;
  if (entities === undefined) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '当前页面不支持从实体新建资产。' });
  }
  const episodeId = readEntityId({ id: source.episodeId }, '集');
  const entityId = readEntityId({ id: source.entityId }, '实体');
  const entity = entities.getEntityDetail(episodeId, entityId);
  const kind: AssetKind = entity.kind;
  const projectStyle = projects.getProject(entity.projectId).visualStyle;
  return {
    schema: {
      title: `新建${ASSET_KIND_LABELS[kind]}`,
      submitLabel: CREATE_SUBMIT_ACTIONS[1].label,
      fields: createFields(kind, categories, 'generated'),
      submitActions: CREATE_SUBMIT_ACTIONS
    },
    initialValues: { ...(projectStyle === null ? {} : { style: projectStyle }), ...buildAssetPrefill(entity) },
    checkField: (key, value) => (key === 'name' && !assets.isNameAvailable(kind, value) ? DUPLICATE_ASSET_NAME_MESSAGE : undefined),
    submit: (values, submitKey) => {
      const categoryId = categories.resolveCategoryId(kind, values[ASSET_CATEGORY_FIELD_KEY] ?? '');
      const generate = submitKey === ASSET_SUBMIT_KEYS.createAndPrompt;
      if (generate) {
        dependencies.prompts.assertCanGenerate(kind, values, false);
      }
      const asset = assets.createAsset(kind, values, { sourceEntityId: entityId, categoryId });
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

/**
 * 创建“编辑资产”表单的定义；类型不能修改，所属分类已被删除时显示为不分类。
 * @param fileSource 表单对应的文件来源：缺省取资产当前的来源；传 upload 且资产当前使用生成时，保存后资产改用上传。
 */
function createEditAssetForm(
  assets: AssetService,
  prompts: AssetPromptService,
  categories: AssetCategoryService,
  assetId: number,
  fileSource: AssetFileSource | undefined
): FormDefinition {
  const asset = assets.getAsset(assetId);
  const mode = fileSource ?? asset.fileSource;
  const isUpload = mode === 'upload';
  const editActions = createEditSubmitActions(hasPrompt(asset));
  const categoryName = asset.categoryId === null ? '' : categories.getCategory(asset.categoryId).name;
  return {
    schema: {
      title: isUpload ? createUploadTitle(asset.kind) : `编辑${ASSET_KIND_LABELS[asset.kind]}`,
      submitLabel: isUpload ? UPLOAD_SUBMIT_LABELS.save : editActions[1].label,
      fields: createFields(asset.kind, categories, mode),
      ...(isUpload ? {} : { submitActions: editActions })
    },
    initialValues: {
      ...toFormValues(asset, mode, isUpload ? assets.getUploadFiles(assetId) : []),
      [ASSET_CATEGORY_FIELD_KEY]: categoryName
    },
    checkField: (key, value) =>
      key === 'name' && !assets.isNameAvailable(asset.kind, value, asset.id) ? DUPLICATE_ASSET_NAME_MESSAGE : undefined,
    submit: (values, submitKey) => {
      const categoryId = categories.resolveCategoryId(asset.kind, values[ASSET_CATEGORY_FIELD_KEY] ?? '');
      const regenerate = submitKey === ASSET_SUBMIT_KEYS.saveAndPrompt;
      if (regenerate) {
        if (assets.getAsset(asset.id).promptStatus === 'running') {
          throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: PROMPT_RUNNING_MESSAGE });
        }
        // 生成来源的表单没有文件字段，是否有图片可供生成提示词看资产当前使用的文件。
        prompts.assertCanGenerate(asset.kind, values, assets.getReferenceFiles(asset.id).length > 0);
      }
      assets.updateAsset(asset.id, values, { categoryId, fileSource: mode });
      if (regenerate) {
        prompts.start(asset.id);
      }
    }
  };
}

/**
 * 创建资产表单目录：新建的参数为 `{ kind, fileSource? }` 或 `{ episodeId, entityId }`（从实体新建），编辑的参数为 `{ assetId, fileSource? }`。
 * @param dependencies 项目、资产、分类与提示词生成服务，以及可选的实体来源。
 */
export function createAssetFormCatalog(dependencies: AssetFormDependencies): SyncFormCatalog {
  return new Map<string, FormFactory>([
    [ASSET_FORM_NAMES.create, (params) => createNewAssetForm(dependencies, params)],
    [
      ASSET_FORM_NAMES.edit,
      (params) =>
        createEditAssetForm(
          dependencies.assets,
          dependencies.prompts,
          dependencies.categories,
          readEntityId({ id: readRecord(params ?? {}).assetId }, '资产'),
          readOptionalFileSource(readRecord(params ?? {}).fileSource)
        )
    ],
    [ASSET_FORM_NAMES.prompt, (params) => createAssetPromptForm(dependencies.assets, dependencies.prompts, readEntityId({ id: readRecord(params ?? {}).assetId }, '资产'))]
  ]);
}
