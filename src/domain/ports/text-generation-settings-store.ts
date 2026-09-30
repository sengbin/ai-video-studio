// ------------------------------------------------------------------------
// 名称：text-generation-settings-store.ts
// 说明：文本生成设置存取与 Copilot 模型清单的端口接口：设置页通过它读写设置、列出可选模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：领域层不依赖 VS Code；扩展中由 VS Code 用户设置与 vscode.lm 实现，测试中用内存实现。
// ------------------------------------------------------------------------

import { TextGenerationSettings, TextGenerationSettingsPatch } from '../rules/text-generation-settings';

/** 文本生成设置的存取。 */
export interface TextGenerationSettingsStore {
  /** 读取当前设置（已规范化）。 */
  read(): TextGenerationSettings;
  /** 写入修改的项，写入完成后下一次读取即为新值。 */
  write(patch: TextGenerationSettingsPatch): Promise<void>;
}

/** 当前可选的文本模型。 */
export interface TextModelFamilies {
  /** 可用的模型家族，已去重。 */
  readonly families: readonly string[];
  /** 列表为空时的原因；有可用模型时为 undefined。 */
  readonly unavailableReason?: string;
}

/** 可选文本模型的清单。 */
export interface TextModelCatalog {
  /** 列出当前可用的模型家族；查询失败时返回空列表和原因，不抛出异常。 */
  listFamilies(): Promise<TextModelFamilies>;
}
