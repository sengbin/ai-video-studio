// ------------------------------------------------------------------------
// 名称：form-schema.ts
// 说明：表单的结构描述：宿主生成，Webview 的表单引擎据此渲染控件并做即时校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：所有字段值以文本传输：选择类字段未选择时为空串，复选框、开关为 true/false，多选（checkboxes）为 JSON 数组文本，文件（file）为“[{name, mimeType, size, data}]”的 JSON 文本（data 为 Base64）。
// ------------------------------------------------------------------------

/** 表单控件类型，对应界面组件库的控件：单行、多行、下拉、单选组、复选框、开关、复选框组、文件选择。 */
export type FormControl = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'switch' | 'checkboxes' | 'file';

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
  /** 输入框的占位示例文字；下拉框用它作为“未选择”项（值为空串）的显示文字，不填为“请选择”。 */
  readonly placeholder?: string;
  /** 多行文本按内容增高的最大行数，超过后出现滚动条；不填用表单引擎的默认值；仅 textarea 使用。 */
  readonly maxRows?: number;
  /** 失去焦点时是否向宿主检查唯一性。 */
  readonly checkUnique?: boolean;
  /** 文件允许的扩展名（小写、含点）；仅 file 使用。 */
  readonly accept?: readonly string[];
  /** 是否可多选；仅 file 使用。 */
  readonly multiple?: boolean;
  /** 最多文件数；仅 file 使用。 */
  readonly maxFiles?: number;
  /** 单个文件大小上限（字节）；仅 file 使用，界面先拦截，宿主会再次校验。 */
  readonly maxFileBytes?: number;
  /** 文件的预览方式：image 为缩略图网格，点击查看原图；不填则按文件名列表显示；仅 file 使用。 */
  readonly preview?: 'image';
  /** 提交前由页面从文件中读取的附加信息：image 为缩略图与宽高，audio 为时长；不填则不读取；仅 file 使用。 */
  readonly derive?: 'image' | 'audio';
  /** 字段只读：显示当前值但不能修改，提交时仍带着该值。 */
  readonly disabled?: boolean;
}

/** 表单里的一个提交按钮：一个表单可以有多个，提交请求带所选按钮的键。 */
export interface FormSubmitActionSchema {
  readonly key: string;
  readonly label: string;
  /** 主按钮：突出显示，并负责回车提交；没有标记时最后一个是主按钮。 */
  readonly primary?: boolean;
  /** 提交前的覆盖确认：指定字段已有内容时询问；fields 为空表示总是询问（宿主已知要覆盖的内容不在表单里）。 */
  readonly confirmOverwrite?: {
    readonly fields: readonly string[];
    readonly title: string;
    readonly message: string;
    readonly confirmText?: string;
  };
}

/** 表单里的一个动作按钮：把当前字段值发给宿主执行（可能较慢，可取消），结果回填到指定字段。 */
export interface FormActionSchema {
  /** 动作键，对应 FormDefinition.actions 的键。 */
  readonly key: string;
  readonly label: string;
  /** 按钮显示在这个字段之前。 */
  readonly before: string;
  /** 执行成功后会被回填的字段键；这些字段已有内容时，回填前先询问是否覆盖。 */
  readonly fills: readonly string[];
  /** 随请求附带图片的文件字段键：只取前若干张、缩小后发送；不填则不发送任何文件字段。 */
  readonly imageField?: string;
  /** 随请求附带的图片数量上限；仅 imageField 有值时使用。 */
  readonly maxImages?: number;
}

/** 表单描述。 */
export interface FormSchema {
  /** 页面标题。 */
  readonly title: string;
  /** 提交按钮文字。 */
  readonly submitLabel: string;
  readonly fields: readonly FormFieldSchema[];
  /** 字段动作按钮，显示在指定字段之前。 */
  readonly actions?: readonly FormActionSchema[];
  /** 多个提交按钮；不填则只有 submitLabel 一个提交按钮。 */
  readonly submitActions?: readonly FormSubmitActionSchema[];
}
