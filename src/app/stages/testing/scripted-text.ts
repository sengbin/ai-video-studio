// ------------------------------------------------------------------------
// 名称：scripted-text.ts
// 说明：测试用的假文本生成端口与标准响应：记录全部请求，按响应函数返回，支持取消；读取真实的提示词模板文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅供自动化测试使用，打包时排除（见 .vscodeignore）；模板目录相对编译产物定位到扩展根目录。
// ------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TextGenerationError } from '../../../domain/errors';
import { PromptTemplates } from '../../../domain/ports/prompt-templates';
import {
  TextGenerationOptions,
  TextGenerationPort,
  TextGenerationRequest,
  TextModelInfo
} from '../../../domain/ports/text-generation-port';

/** 编译产物位于 out/app/stages/testing，扩展根目录在其上四级。 */
const PROMPTS_DIRECTORY = join(resolve(__dirname, '..', '..', '..', '..'), 'resources', 'prompts');

/** 默认的假模型信息。 */
export const DEFAULT_MODEL: TextModelInfo = { id: 'copilot/test', maxInputTokens: 100000, supportsImageInput: true };

/** 响应函数：根据请求与调用序号返回模型输出，可返回永不结束的 Promise 模拟卡住。 */
export type Responder = (request: TextGenerationRequest, callIndex: number) => string | Promise<string>;

/** 读取真实的提示词模板文件（保持原样换行）。 */
export function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIRECTORY, `${name}.md`), 'utf8');
}

/** 从真实模板文件读取的提示词来源。 */
export const FILE_PROMPTS: PromptTemplates = { get: readPrompt };

/** 脚本化的假文本生成端口。 */
export class ScriptedText implements TextGenerationPort {
  readonly requests: TextGenerationRequest[] = [];
  /** 为 true 时 resolveModel 抛出“不可用”错误。 */
  unavailable = false;

  constructor(
    private readonly responder: Responder,
    private readonly model: TextModelInfo = DEFAULT_MODEL
  ) {}

  async resolveModel(): Promise<TextModelInfo> {
    if (this.unavailable) {
      throw new TextGenerationError('unavailable', '未安装或未登录 Copilot。');
    }
    return this.model;
  }

  async countTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 2);
  }

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<string> {
    this.requests.push(request);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw new TextGenerationError('canceled', '已取消。');
    }
    const pending = Promise.resolve(this.responder(request, this.requests.length - 1));
    if (signal === undefined) {
      return pending;
    }
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new TextGenerationError('canceled', '已取消。')), { once: true });
      })
    ]);
  }
}

/** 默认响应：按请求中的任务标题返回符合要求的 JSON。 */
export function standardResponder(request: TextGenerationRequest): string {
  const user = request.user;
  if (user.includes('# 任务：提取原文要点')) {
    return JSON.stringify({ summary: `要点${/第 (\d+) 段/.exec(user)?.[1] ?? ''}` });
  }
  if (user.includes('# 任务：分析灵感图片')) {
    return JSON.stringify({ summary: '画面：灯塔与海' });
  }
  if (user.includes('# 任务：规划章节大纲')) {
    return JSON.stringify({
      chapters: [
        { title: '开端', summary: '守夜人上岗', sources: [1] },
        { title: '转折', summary: '收到信号', sources: [2] },
        { title: '结局', summary: '真相', sources: [3] }
      ]
    });
  }
  const chapter = /# 任务：撰写第 (\d+) 章/.exec(user);
  if (chapter !== null) {
    return JSON.stringify({ title: `第${chapter[1]}章`, content: '灯'.repeat(120) });
  }
  throw new Error(`未预期的请求：${user.slice(0, 40)}`);
}
