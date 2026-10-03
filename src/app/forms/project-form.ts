// ------------------------------------------------------------------------
// 名称：project-form.ts
// 说明：项目表单（F1）的定义：字段描述、初始值、名称唯一性检查和提交。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：字段约束取自领域规则常量，保证界面与宿主校验一致。
// ------------------------------------------------------------------------

import { Project } from '../../domain/models/project';
import {
  VIDEO_ASPECT_RATIO_OPTIONS,
  VIDEO_RESOLUTION_OPTIONS,
  VISUAL_STYLE_OPTIONS
} from '../../domain/models/option-sets';
import { readEntityId } from '../../domain/rules/field-readers';
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_VISUAL_STYLE_MAX_LENGTH
} from '../../domain/rules/project-rules';
import { DUPLICATE_PROJECT_NAME_MESSAGE, ProjectService } from '../services/project-service';
import { SyncFormCatalog, FormDefinition, FormFactory, FormValues } from './form-definition';
import { FormSchema } from './form-schema';

/** 项目表单在表单目录中的名称，页面据此请求打开。 */
export const PROJECT_FORM_NAMES = {
  create: 'project.create',
  edit: 'project.edit'
} as const;

const CREATE_FORM_TITLE = '新建项目';
const EDIT_FORM_TITLE = '编辑项目';
const SUBMIT_LABEL = '保存';

/** 构造项目表单的字段描述。 */
function createProjectSchema(title: string): FormSchema {
  return {
    title,
    submitLabel: SUBMIT_LABEL,
    fields: [
      {
        key: 'name',
        label: '项目名称',
        description: `项目的唯一名称，最多 ${PROJECT_NAME_MAX_LENGTH} 字`,
        control: 'text',
        required: true,
        maxLength: PROJECT_NAME_MAX_LENGTH,
        placeholder: '例如：灯塔计划',
        checkUnique: true
      },
      {
        key: 'description',
        label: '项目描述',
        description: `简要说明项目内容，最多 ${PROJECT_DESCRIPTION_MAX_LENGTH} 字`,
        control: 'textarea',
        required: false,
        maxLength: PROJECT_DESCRIPTION_MAX_LENGTH
      },
      {
        key: 'visualStyle',
        label: '视觉风格',
        description: `项目内的角色、场景和分镜脚本默认沿用该风格，也可选择“其他”手动输入（最多 ${PROJECT_VISUAL_STYLE_MAX_LENGTH} 字）`,
        control: 'select',
        required: false,
        maxLength: PROJECT_VISUAL_STYLE_MAX_LENGTH,
        options: VISUAL_STYLE_OPTIONS,
        allowCustom: true
      },
      {
        key: 'defaultAspectRatio',
        label: '默认画幅',
        description: '作品的默认画幅，可在作品和镜头中覆盖',
        control: 'select',
        required: false,
        options: VIDEO_ASPECT_RATIO_OPTIONS
      },
      {
        key: 'defaultResolution',
        label: '默认分辨率',
        description: '作品的默认分辨率，可在作品和镜头中覆盖',
        control: 'select',
        required: false,
        options: VIDEO_RESOLUTION_OPTIONS
      }
    ]
  };
}

/** 项目转表单初始值：未设置的选项为空串。 */
function toFormValues(project: Project): FormValues {
  return {
    name: project.name,
    description: project.description,
    visualStyle: project.visualStyle ?? '',
    defaultAspectRatio: project.defaultAspectRatio ?? '',
    defaultResolution: project.defaultResolution ?? ''
  };
}

/**
 * 创建“新建项目”表单的定义。
 * @param service 项目服务。
 */
export function createNewProjectForm(service: ProjectService): FormDefinition {
  return {
    schema: createProjectSchema(CREATE_FORM_TITLE),
    initialValues: {},
    checkField: (key, value) =>
      key === 'name' && !service.isProjectNameAvailable(value) ? DUPLICATE_PROJECT_NAME_MESSAGE : undefined,
    submit: (values) => {
      service.createProject(values);
    }
  };
}

/**
 * 创建“编辑项目”表单的定义。
 * @param service 项目服务。
 * @param project 被编辑的项目。
 */
export function createEditProjectForm(service: ProjectService, project: Project): FormDefinition {
  return {
    schema: createProjectSchema(EDIT_FORM_TITLE),
    initialValues: toFormValues(project),
    checkField: (key, value) =>
      key === 'name' && !service.isProjectNameAvailable(value, project.id) ? DUPLICATE_PROJECT_NAME_MESSAGE : undefined,
    submit: (values) => {
      service.updateProject(project.id, values);
    }
  };
}

/**
 * 创建项目表单目录：新建不需要参数，编辑的参数为 `{ id }`。
 * @param service 项目服务。
 */
export function createProjectFormCatalog(service: ProjectService): SyncFormCatalog {
  return new Map<string, FormFactory>([
    [PROJECT_FORM_NAMES.create, () => createNewProjectForm(service)],
    [PROJECT_FORM_NAMES.edit, (params) => createEditProjectForm(service, service.getProject(readEntityId(params, '项目')))]
  ]);
}
