// ------------------------------------------------------------------------
// 名称：asset-prompt-form.ts
// 说明：资产提示词表单（F14）的定义：查看、手动修改资产的中英文提示词，或重新让 Copilot 生成。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：提示词不在资产表单里；保存即视为已确认（不再显示“需更新”）；提示词生成中字段只读；表单带文本模型下拉，所选模型只对本次重新生成有效；“重新生成”按资产已保存的设定生成，表单里未保存的修改会被丢弃，因此已有内容时先确认覆盖。
// ------------------------------------------------------------------------

import { AssetRecord } from '../../domain/models/asset';
import { hasPrompt, isPromptOutdated } from '../../domain/rules/asset-generation-rules';
import { ASSET_PROMPT_MAX_LENGTH } from '../../domain/rules/asset-rules';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { FormDefinition } from './form-definition';
import { FormFieldSchema, FormSubmitActionSchema } from './form-schema';
import { TEXT_MODEL_FIELD_KEY, TextModelStates, createTextModelField, readTextModelKey, textModelInitialValue } from './text-model-field';

/** 提示词表单在表单目录中的名称。 */
export const ASSET_PROMPT_FORM_NAME = 'asset.prompt';

/** 提交按钮的键：保存、重新生成。 */
export const ASSET_PROMPT_SUBMIT_KEYS = { save: 'save', regenerate: 'regenerate' } as const;

const PROMPT_MAX_ROWS = 10;
const TEXT_MODEL_PURPOSE = '重新生成提示词时';
const TEXT_MODEL_NOTE = '；仅对本次生成有效，“保存”不会用到';

/** 中文提示词字段下方的说明：优先显示需要用户注意的状态。 */
function describePromptState(asset: AssetRecord): string {
  if (asset.promptStatus === 'running') return '提示词生成中，完成后再修改。';
  if (asset.promptStatus === 'failed') return `上次生成失败：${asset.promptError ?? '未知原因'}`;
  if (asset.promptStatus === 'canceled') return '上次生成已取消。';
  if (isPromptOutdated(asset)) return '资产设定在提示词之后改过，提示词可能需要更新；确认无误后保存即可，也可以重新生成。';
  const purpose = asset.kind === 'audio' ? '音频生成提示词' : '图像生成提示词';
  return `${purpose}，可手动编辑，最多 ${ASSET_PROMPT_MAX_LENGTH} 字；保存即视为已确认`;
}

function createPromptField(key: 'promptZh' | 'promptEn', label: string, description: string, disabled: boolean): FormFieldSchema {
  return { key, label, description, control: 'textarea', required: false, maxLength: ASSET_PROMPT_MAX_LENGTH, maxRows: PROMPT_MAX_ROWS, disabled };
}

/**
 * 创建“资产提示词”表单的定义。
 * @param textModels 文本模型的候选，重新生成时可以手动选择本次使用的模型。
 * @throws NotFoundError 资产不存在。
 */
export async function createAssetPromptForm(
  assets: AssetService,
  prompts: AssetPromptService,
  textModels: TextModelStates,
  assetId: number
): Promise<FormDefinition> {
  const asset = assets.getAsset(assetId);
  const textModelState = await textModels.getWorkState(null);
  const locked = asset.promptStatus === 'running';
  const existing = hasPrompt(asset);
  const regenerateLabel = existing ? '重新生成提示词' : '生成提示词';
  const submitActions: FormSubmitActionSchema[] = [
    { key: ASSET_PROMPT_SUBMIT_KEYS.save, label: '保存', primary: existing },
    {
      key: ASSET_PROMPT_SUBMIT_KEYS.regenerate,
      label: regenerateLabel,
      primary: !existing,
      confirmOverwrite: { fields: ['promptZh', 'promptEn'], title: '覆盖现有提示词', message: '将用重新生成的提示词覆盖现有提示词，表单里未保存的修改也会丢失，确定吗？', confirmText: '覆盖' }
    }
  ];
  return {
    schema: {
      title: `提示词：${asset.name}`,
      submitLabel: regenerateLabel,
      fields: [
        createPromptField('promptZh', '中文提示词', describePromptState(asset), locked),
        createPromptField('promptEn', '英文提示词', `与中文含义一致，最多 ${ASSET_PROMPT_MAX_LENGTH} 字`, locked),
        { ...createTextModelField(textModelState, TEXT_MODEL_PURPOSE, TEXT_MODEL_NOTE), disabled: locked }
      ],
      submitActions
    },
    initialValues: { promptZh: asset.promptZh, promptEn: asset.promptEn, [TEXT_MODEL_FIELD_KEY]: textModelInitialValue(textModelState) },
    submit: (values, submitKey) => {
      if (submitKey === ASSET_PROMPT_SUBMIT_KEYS.regenerate) {
        prompts.start(asset.id, readTextModelKey(textModelState, values));
        return;
      }
      assets.updatePrompts(asset.id, values);
    }
  };
}
