// ------------------------------------------------------------------------
// 名称：form-schema.ts
// 说明：表单的结构描述：宿主生成，Webview 的表单引擎据此渲染控件并做即时校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：所有字段值以文本传输：选择类字段未选择时为空串，复选框、开关为 true/false，多选（checkboxes）为 JSON 数组文本。
// ------------------------------------------------------------------------

/** 表单控件类型，对应界面组件库的控件：单行、多行、下拉、单选组、复选框、开关、复选框组。 */
export type FormControl = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'switch' | 'checkboxes';

/** 单个字段的描述。 */
export interface FormFieldSchema {
  /** 字段键，也是提交内容中的键。 */
  readonly key: string;
  readonly label: string;
  /** 标签下方的说明文字。 */
  readonly description: string;
  readonly control: FormControl;
  readonly required: boolean;
  /** 最大长度，用于界面即时校验；宿主会再次校验。 */
  readonly maxLength?: number;
  /** 选项；仅 select、radio、checkboxes 使用。 */
  readonly options?: readonly string[];
  /** 下拉框是否提供“其他（手动输入）”；仅 select 使用。 */
  readonly allowCustom?: boolean;
  /** 输入框的占位示例文字。 */
  readonly placeholder?: string;
  /** 失去焦点时是否向宿主检查唯一性。 */
  readonly checkUnique?: boolean;
}

/** 表单描述。 */
export interface FormSchema {
  /** 页面标题。 */
  readonly title: string;
  /** 提交按钮文字。 */
  readonly submitLabel: string;
  readonly fields: readonly FormFieldSchema[];
}
