// ------------------------------------------------------------------------
// 名称：model-provider.ts
// 说明：模型服务商与模型的领域模型：适配器声明的描述符，以及数据库中的服务商、模型记录和设置页视图。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：描述符由适配器（代码）提供，同步到数据库后用户只能改启用状态和服务商设置；密钥不属于这些模型，只存 SecretStorage。
// ------------------------------------------------------------------------

import { CapabilityByKind, ModelCapability, ModelKind } from './model-capability';

/** 服务商设置项的取值格式：目前只有 https 地址。 */
export type ProviderSettingFormat = 'https-url';

/** 服务商设置项的下拉选项。 */
export interface ProviderSettingOption {
  readonly value: string;
  readonly label: string;
}

/** 适配器声明的一个服务商设置项，设置页据此渲染字段；取值保存在 providers.settings_json。 */
export interface ProviderSettingField {
  /** 设置键，同一服务商内唯一。 */
  readonly key: string;
  readonly label: string;
  /** 字段下方的说明文字。 */
  readonly description?: string;
  /** 控件：单行输入或下拉；下拉时必须提供 options。 */
  readonly control: 'text' | 'select';
  readonly options?: readonly ProviderSettingOption[];
  /** 用户没有修改时使用的值。 */
  readonly defaultValue: string;
  readonly format?: ProviderSettingFormat;
}

/** 适配器声明的服务商信息；同一服务商的不同类型适配器必须声明相同的内容。 */
export interface ProviderDescriptor {
  /** 唯一标识，如 qianwen；同时用于数据库和密钥名称。 */
  readonly code: string;
  readonly displayName: string;
  readonly settingFields: readonly ProviderSettingField[];
}

/** 适配器声明的一个模型及其能力。 */
export interface ModelDescriptor<TKind extends ModelKind = ModelKind> {
  /** 服务商侧的模型标识，如 wan3.0-video。 */
  readonly code: string;
  readonly displayName: string;
  readonly kind: TKind;
  readonly capability: CapabilityByKind[TKind];
}

/** 服务商设置的取值：键为设置键。 */
export type ProviderSettings = Readonly<Record<string, string>>;

/** 数据库中的服务商。 */
export interface ProviderRecord {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly settings: ProviderSettings;
  readonly isEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 数据库中的模型，带能力描述。 */
export interface ModelRecord {
  readonly id: number;
  readonly providerId: number;
  readonly code: string;
  readonly displayName: string;
  readonly kind: ModelKind;
  readonly isEnabled: boolean;
  readonly capability: ModelCapability;
  readonly createdAt: string;
}

/** 新增服务商所需的内容。 */
export interface NewProvider {
  readonly code: string;
  readonly displayName: string;
  readonly settings: ProviderSettings;
}

/** 对服务商的一次修改，只包含要改的项。 */
export interface ProviderPatch {
  readonly isEnabled?: boolean;
  readonly settings?: ProviderSettings;
}

/** 设置页展示的服务商设置项：声明加当前值。 */
export interface ProviderSettingView extends ProviderSettingField {
  readonly value: string;
}

/** 设置页展示的模型。 */
export interface ModelView {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly kind: ModelKind;
  readonly kindLabel: string;
  readonly isEnabled: boolean;
  /** 能力摘要，每项一行，如“画幅：16:9、9:16”。 */
  readonly capabilitySummary: readonly string[];
}

/** 设置页展示的服务商。 */
export interface ProviderView {
  readonly id: number;
  readonly code: string;
  readonly displayName: string;
  readonly isEnabled: boolean;
  /** 是否已配置访问密钥；密钥本身不会发给界面。 */
  readonly apiKeyConfigured: boolean;
  readonly settings: readonly ProviderSettingView[];
  readonly models: readonly ModelView[];
}

/** 可以实际使用的模型：模型与服务商都已启用且已配置密钥。 */
export interface UsableModel {
  readonly model: ModelRecord;
  readonly providerCode: string;
  readonly providerName: string;
}
