// ------------------------------------------------------------------------
// 名称：copilot-model-catalog.ts
// 说明：Copilot 可选模型清单：通过 VS Code 语言模型接口列出当前可用的模型家族。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：查询失败或没有模型时返回空列表和原因，不抛出异常，设置页据此提示用户。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { TextModelCatalog, TextModelFamilies } from '../../domain/ports/text-generation-settings-store';

const COPILOT_VENDOR = 'copilot';
const UNAVAILABLE_REASON = '未检测到可用的 Copilot 模型，请确认已安装并登录 GitHub Copilot。';

/** 基于 vscode.lm 的模型清单。 */
export class CopilotModelCatalog implements TextModelCatalog {
  async listFamilies(): Promise<TextModelFamilies> {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR });
      const families = [...new Set(models.map((model) => model.family))].sort();
      return families.length === 0 ? { families, unavailableReason: UNAVAILABLE_REASON } : { families };
    } catch {
      return { families: [], unavailableReason: UNAVAILABLE_REASON };
    }
  }
}