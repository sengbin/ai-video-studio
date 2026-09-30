// ------------------------------------------------------------------------
// 名称：vscode-text-generation-settings.ts
// 说明：从 VS Code 用户设置读取文本生成设置：Copilot 模型家族、小说分段方式与每段字数上限。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：每次读取都取最新值，设置修改后下一次生成立即生效；键名见 package.json 的 contributes.configuration。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { NovelSplitSettings } from '../../domain/rules/novel-splitter';
import { TextGenerationSettings, normalizeTextGenerationSettings } from '../../domain/rules/text-generation-settings';
import { CopilotModelSettings } from './copilot-text-generation';

const CONFIGURATION_SECTION = 'aiVideoStudio';

/** 读取文本生成设置。 */
export class VsCodeTextGenerationSettings implements CopilotModelSettings {
  /** 读取并规范化当前设置。 */
  read(): TextGenerationSettings {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    return normalizeTextGenerationSettings({
      modelFamily: configuration.get('copilot.modelFamily'),
      splitMode: configuration.get('novel.splitMode'),
      maxSegmentChars: configuration.get('novel.maxSegmentChars')
    });
  }

  getModelFamily(): string {
    return this.read().modelFamily;
  }

  getSplitSettings(): NovelSplitSettings {
    return this.read().novelSplit;
  }
}
