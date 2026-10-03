// ------------------------------------------------------------------------
// 名称：vscode-text-generation-settings.ts
// 说明：读写 VS Code 用户设置中的文本生成设置：是否使用 Copilot、Copilot 模型家族、小说分段方式与每段字数上限。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：每次读取都取最新值，设置修改后下一次生成立即生效；键名见 package.json 的 contributes.configuration。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { NovelSplitSettings } from '../../domain/rules/novel-splitter';
import { TextGenerationSettingsStore } from '../../domain/ports/text-generation-settings-store';
import {
  TextGenerationSettings,
  TextGenerationSettingsPatch,
  normalizeTextGenerationSettings
} from '../../domain/rules/text-generation-settings';
import { CopilotModelSettings } from './copilot-text-generation';

const CONFIGURATION_SECTION = 'aigcVideoStudio';

/** 读写文本生成设置。 */
export class VsCodeTextGenerationSettings implements CopilotModelSettings, TextGenerationSettingsStore {
  /** 读取并规范化当前设置。 */
  read(): TextGenerationSettings {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    return normalizeTextGenerationSettings({
      copilotEnabled: configuration.get('copilot.enabled'),
      modelFamily: configuration.get('copilot.modelFamily'),
      splitMode: configuration.get('novel.splitMode'),
      maxSegmentChars: configuration.get('novel.maxSegmentChars')
    });
  }

  /** 把修改写入用户设置（全局），只写出现的项。 */
  async write(patch: TextGenerationSettingsPatch): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const target = vscode.ConfigurationTarget.Global;
    if (patch.copilotEnabled !== undefined) {
      await configuration.update('copilot.enabled', patch.copilotEnabled, target);
    }
    if (patch.modelFamily !== undefined) {
      await configuration.update('copilot.modelFamily', patch.modelFamily, target);
    }
    if (patch.splitMode !== undefined) {
      await configuration.update('novel.splitMode', patch.splitMode, target);
    }
    if (patch.maxSegmentChars !== undefined) {
      await configuration.update('novel.maxSegmentChars', patch.maxSegmentChars, target);
    }
  }

  getModelFamily(): string {
    return this.read().modelFamily;
  }

  /** 是否使用 Copilot 生成文本。 */
  isCopilotEnabled(): boolean {
    return this.read().copilotEnabled;
  }

  getSplitSettings(): NovelSplitSettings {
    return this.read().novelSplit;
  }
}
