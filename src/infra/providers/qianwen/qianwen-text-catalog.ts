// ------------------------------------------------------------------------
// 名称：qianwen-text-catalog.ts
// 说明：千问AI平台文本模型目录：可用于生成创意、剧本、分镜脚本与资产提示词的文本模型及其能力，以及对话接口的路径。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：数值来自千问AI平台文档“文本生成模型”“视觉理解模型”：只收录支持函数调用、可通过 enable_thinking 关闭思考（强制指定工具要求关闭思考）且支持图片输入的混合思考模型；平台上新增或调整模型时只改这里。
// ------------------------------------------------------------------------

import { TextCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor } from '../../../domain/models/model-provider';

/** 对话接口的路径，相对 OpenAI 兼容接口地址。 */
export const TEXT_CHAT_PATH = '/chat/completions';

/** Qwen3.8 系列：1M 上下文，单次最多输出 128K。 */
const QWEN_38_CAPABILITY: TextCapability = { contextTokens: 1_000_000, maxOutputTokens: 128_000, imageInput: true };

/** Qwen3.7、Qwen3.6 系列：1M 上下文，单次最多输出 64K。 */
const QWEN_37_CAPABILITY: TextCapability = { contextTokens: 1_000_000, maxOutputTokens: 64_000, imageInput: true };

/** 千问AI平台提供的文本模型。 */
export const QIANWEN_TEXT_MODELS: readonly ModelDescriptor<'text'>[] = [
  { code: 'qwen3.8-max', displayName: 'Qwen3.8 Max（旗舰）', kind: 'text', capability: QWEN_38_CAPABILITY },
  { code: 'qwen3.8-flash', displayName: 'Qwen3.8 Flash（轻量）', kind: 'text', capability: QWEN_38_CAPABILITY },
  { code: 'qwen3.7-plus', displayName: 'Qwen3.7 Plus（均衡）', kind: 'text', capability: QWEN_37_CAPABILITY },
  { code: 'qwen3.7-flash', displayName: 'Qwen3.7 Flash（轻量）', kind: 'text', capability: QWEN_37_CAPABILITY },
  { code: 'qwen3.6-plus', displayName: 'Qwen3.6 Plus（均衡）', kind: 'text', capability: QWEN_37_CAPABILITY },
  { code: 'qwen3.6-flash', displayName: 'Qwen3.6 Flash（轻量）', kind: 'text', capability: QWEN_37_CAPABILITY }
];
