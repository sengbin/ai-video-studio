// ------------------------------------------------------------------------
// 名称：qianwen-text-provider.ts
// 说明：千问AI平台文本适配器：通过 OpenAI 兼容的对话接口生成文本，强制模型调用输出工具返回结构化结果，支持随请求发送图片。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用流式输出降低长内容生成超时的风险；强制指定工具时必须关闭思考（enable_thinking 为 false）；输出被截断（finish_reason 为 length）时直接报错，不使用不完整的结果。
// ------------------------------------------------------------------------

import { ProviderError } from '../../../domain/errors';
import { TextCapability } from '../../../domain/models/model-capability';
import { ModelDescriptor, ProviderDescriptor } from '../../../domain/models/model-provider';
import { ProviderCallContext, TextModelProvider } from '../../../domain/ports/provider-adapters';
import { TextGenerationRequest } from '../../../domain/ports/text-generation-port';
import { FetchFunction, QianwenApiClient, classifyErrorCode } from './qianwen-api-client';
import { QIANWEN_PROVIDER } from './qianwen-catalog';
import { toDataUri } from './qianwen-protocol';
import { QIANWEN_TEXT_MODELS, TEXT_CHAT_PATH } from './qianwen-text-catalog';

/** 流式响应中累积的一次工具调用。 */
interface ToolCallDraft {
  name: string;
  argumentsText: string;
}

/** 千问AI平台的文本适配器。 */
export class QianwenTextProvider implements TextModelProvider {
  readonly kind = 'text';
  readonly provider: ProviderDescriptor = QIANWEN_PROVIDER;
  private readonly client: QianwenApiClient;

  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   */
  constructor(fetchFunction?: FetchFunction) {
    this.client = new QianwenApiClient(fetchFunction);
  }

  listModels(): readonly ModelDescriptor<'text'>[] {
    return QIANWEN_TEXT_MODELS;
  }

  getCapability(modelCode: string): TextCapability | undefined {
    return QIANWEN_TEXT_MODELS.find((model) => model.code === modelCode)?.capability;
  }

  async generate(modelCode: string, request: TextGenerationRequest, context: ProviderCallContext): Promise<unknown> {
    const capability = this.getCapability(modelCode);
    if (capability === undefined) {
      throw new ProviderError('invalid_request', `千问AI平台没有文本模型 ${modelCode}。`);
    }
    if ((request.images ?? []).length > 0 && !capability.imageInput) {
      throw new ProviderError('invalid_request', `模型 ${modelCode} 不支持图片输入，请换用支持图片的文本模型。`);
    }

    const calls = new Map<number, ToolCallDraft>();
    let content = '';
    let finishReason: string | null = null;
    for await (const data of this.client.postEventStream(context, TEXT_CHAT_PATH, buildBody(modelCode, request, capability))) {
      const choice = readChoice(data);
      content += choice.content;
      for (const call of choice.toolCalls) {
        const draft = calls.get(call.index) ?? { name: '', argumentsText: '' };
        draft.name += call.name;
        draft.argumentsText += call.argumentsText;
        calls.set(call.index, draft);
      }
      finishReason = choice.finishReason ?? finishReason;
    }

    if (finishReason === 'length') {
      throw new ProviderError('invalid_request', '模型的输出超出最大长度被截断，请在“模型设置”中调小“每段字数上限”后重试。');
    }
    const drafts = [...calls.values()];
    const chosen = drafts.find((draft) => draft.name === request.tool.name) ?? drafts[0];
    if (chosen === undefined) {
      const detail = content.trim() === '' ? '' : `：${content.trim().slice(0, 200)}`;
      throw new ProviderError('invalid_request', `模型没有通过工具返回结果${detail}`);
    }
    return parseToolArguments(chosen.argumentsText);
  }
}

/** 构造对话请求体：系统段与用户段分开发送，强制调用输出工具，关闭思考。 */
function buildBody(modelCode: string, request: TextGenerationRequest, capability: TextCapability): Record<string, unknown> {
  const images = request.images ?? [];
  const userContent =
    images.length === 0
      ? request.user
      : [...images.map((image) => ({ type: 'image_url', image_url: { url: toDataUri(image) } })), { type: 'text', text: request.user }];
  return {
    model: modelCode,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: userContent }
    ],
    stream: true,
    enable_thinking: false,
    max_tokens: capability.maxOutputTokens,
    tools: [{ type: 'function', function: { name: request.tool.name, description: request.tool.description, parameters: request.tool.inputSchema } }],
    tool_choice: { type: 'function', function: { name: request.tool.name } }
  };
}

/** 一个流式事件中与结果有关的内容。 */
interface ChoiceDelta {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<{ readonly index: number; readonly name: string; readonly argumentsText: string }>;
  readonly finishReason: string | null;
}

const EMPTY_DELTA: ChoiceDelta = { content: '', toolCalls: [], finishReason: null };

/**
 * 解析一个流式事件。无法解析或没有候选的事件（如用量统计）忽略；事件里带错误信息时抛出。
 * @throws ProviderError 事件是错误信息。
 */
function readChoice(data: string): ChoiceDelta {
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return EMPTY_DELTA;
  }
  if (!isRecord(chunk)) {
    return EMPTY_DELTA;
  }
  if (isRecord(chunk.error)) {
    const code = typeof chunk.error.code === 'string' ? chunk.error.code : null;
    const message = typeof chunk.error.message === 'string' ? chunk.error.message : '未知错误';
    throw new ProviderError(classifyErrorCode(code) ?? 'server', `千问AI平台返回错误${code === null ? '' : `（${code}）`}：${message}`, { code });
  }
  const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : undefined;
  if (choice === undefined) {
    return EMPTY_DELTA;
  }
  const delta = isRecord(choice.delta) ? choice.delta : {};
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    toolCalls: toolCalls.map((call, position) => {
      const fn = isRecord(call.function) ? call.function : {};
      return {
        index: typeof call.index === 'number' ? call.index : position,
        name: typeof fn.name === 'string' ? fn.name : '',
        argumentsText: typeof fn.arguments === 'string' ? fn.arguments : ''
      };
    }),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  };
}

/** 把工具参数文本解析为对象。 */
function parseToolArguments(argumentsText: string): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    throw new ProviderError('invalid_request', '模型返回的工具参数不是合法的 JSON，请重试。', { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new ProviderError('invalid_request', '模型返回的工具参数不是 JSON 对象，请重试。');
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
