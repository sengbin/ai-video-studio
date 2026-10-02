// ------------------------------------------------------------------------
// 名称：asset-form.ts
// 说明：资产表单（F6）的定义：新建与编辑角色、场景、道具、特效、音频资产；字段、选项与上传限制随类型变化。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：类型由入口决定、创建后不能修改；新建时在表单里选择所属项目（入口可传默认项目），编辑时不显示项目；字段约束取自领域规则常量，保证界面与宿主校验一致；表单引擎不支持字段联动与折叠，风格留空表示沿用项目风格，语言仅对音色参考有效。
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
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { ASSET_PROJECT_FIELD_KEY, AssetService, DUPLICATE_ASSET_NAME_MESSAGE } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { FormCatalog, FormDefinition, FormFactory, FormValues } from './form-definition';
import { FormFieldSchema } from './form-schema';

/** 资产表单在表单目录中的名称，页面据此请求打开。 */
export const ASSET_FORM_NAMES = {
  create: 'asset.create',
  edit: 'asset.edit'
} as const;

const SUBMIT_LABEL = '保存';
const NO_PROJECT_MESSAGE = '还没有项目，请先在“所有项目”中创建项目。';
const MEGABYTE = 1024 * 1024;
const PROMPT_MAX_ROWS = 6;
/** 参考图以外的长文本描述最多长到的行数。 */
const ATTRIBUTE_MAX_ROWS = 4;

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
    {
      key: 'promptZh',
      label: '中文提示词',
      description: `图像生成提示词，可手动编辑，最多 ${ASSET_PROMPT_MAX_LENGTH} 字`,
      control: 'textarea',
      required: false,
      maxLength: ASSET_PROMPT_MAX_LENGTH,
      maxRows: PROMPT_MAX_ROWS
    },
    {
      key: 'promptEn',
      label: '英文提示词',
      description: `图像生成提示词，可手动编辑，最多 ${ASSET_PROMPT_MAX_LENGTH} 字`,
      control: 'textarea',
      required: false,
      maxLength: ASSET_PROMPT_MAX_LENGTH,
      maxRows: PROMPT_MAX_ROWS
    },
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

/** 音频资产的字段。 */
function createAudioFields(): FormFieldSchema[] {
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
    {
      key: ASSET_FILE_FIELD_KEY,
      label: '音频文件',
      description: `MP3、WAV、M4A；不超过 ${ASSET_AUDIO_MAX_BYTES / MEGABYTE} MB，时长不超过 ${ASSET_AUDIO_MAX_SECONDS} 秒；保存时读取时长，无法解码的文件会提示`,
      control: 'file',
      required: true,
      accept: ASSET_AUDIO_EXTENSIONS,
      multiple: false,
      maxFileBytes: ASSET_AUDIO_MAX_BYTES,
      derive: 'audio'
    },
    createExtraField()
  ];
}

/** 按类型组装表单字段；新建时带所属项目。 */
function createFields(kind: AssetKind, projectNames: readonly string[] | undefined, checkUnique: boolean): FormFieldSchema[] {
  return [
    ...(projectNames === undefined ? [] : [createProjectField(projectNames)]),
    createNameField(kind, checkUnique),
    ...(kind === 'audio' ? createAudioFields() : createImageFields(kind))
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
  values.promptZh = asset.promptZh;
  values.promptEn = asset.promptEn;
  for (const field of ASSET_ATTRIBUTE_FIELDS[asset.kind]) {
    values[field.formKey] = asset.attributes[field.key] ?? '';
  }
  return values;
}

/** 新建资产表单依赖的服务。 */
export interface AssetFormDependencies {
  readonly projects: ProjectService;
  readonly assets: AssetService;
}

/**
 * 创建“新建资产”表单的定义。
 * @param params `{ kind, projectId? }`，projectId 为入口筛选的项目，作为所属项目的默认值。
 */
function createNewAssetForm(dependencies: AssetFormDependencies, params: unknown): FormDefinition {
  const { projects, assets } = dependencies;
  const source = readRecord(params ?? {});
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
      submitLabel: SUBMIT_LABEL,
      fields: createFields(kind, summaries.map((project) => project.name), false)
    },
    initialValues: {
      ...(defaultProject === undefined ? {} : { [ASSET_PROJECT_FIELD_KEY]: defaultProject.name }),
      ...(kind === 'audio' ? { audioKind: AUDIO_KIND_LABELS.voice } : {})
    },
    submit: (values) => {
      assets.createAsset(kind, values);
    }
  };
}

/** 创建“编辑资产”表单的定义；所属项目与类型不能修改，因此不显示项目字段。 */
function createEditAssetForm(assets: AssetService, assetId: number): FormDefinition {
  const asset = assets.getAsset(assetId);
  return {
    schema: {
      title: `编辑${ASSET_KIND_LABELS[asset.kind]}`,
      submitLabel: SUBMIT_LABEL,
      fields: createFields(asset.kind, undefined, true)
    },
    initialValues: toFormValues(asset, assets.getReferenceFiles(assetId)),
    checkField: (key, value) =>
      key === 'name' && !assets.isNameAvailable(asset.projectId, asset.kind, value, asset.id) ? DUPLICATE_ASSET_NAME_MESSAGE : undefined,
    submit: (values) => {
      assets.updateAsset(asset.id, values);
    }
  };
}

/**
 * 创建资产表单目录：新建的参数为 `{ kind, projectId? }`，编辑的参数为 `{ assetId }`。
 * @param dependencies 项目与资产服务。
 */
export function createAssetFormCatalog(dependencies: AssetFormDependencies): FormCatalog {
  return new Map<string, FormFactory>([
    [ASSET_FORM_NAMES.create, (params) => createNewAssetForm(dependencies, params)],
    [
      ASSET_FORM_NAMES.edit,
      (params) => createEditAssetForm(dependencies.assets, readEntityId({ id: readRecord(params ?? {}).assetId }, '资产'))
    ]
  ]);
}
