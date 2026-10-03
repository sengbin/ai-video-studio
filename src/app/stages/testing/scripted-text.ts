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
  TextGenerationSource,
  TextModelInfo
} from '../../../domain/ports/text-generation-port';

/** 编译产物位于 out/app/stages/testing，扩展根目录在其上四级。 */
const PROMPTS_DIRECTORY = join(resolve(__dirname, '..', '..', '..', '..'), 'resources', 'prompts');

/** 默认的假模型信息。 */
export const DEFAULT_MODEL: TextModelInfo = { id: 'copilot/test', maxInputTokens: 100000 };

/** 响应函数：根据请求与调用序号返回模型提交的结果对象，可返回永不结束的 Promise 模拟卡住。 */
export type Responder = (request: TextGenerationRequest, callIndex: number) => unknown;

/** 读取真实的提示词模板文件（保持原样换行）。 */
export function readPrompt(name: string): string {
  return readFileSync(join(PROMPTS_DIRECTORY, `${name}.md`), 'utf8');
}

/** 从真实模板文件读取的提示词来源。 */
export const FILE_PROMPTS: PromptTemplates = { get: readPrompt };

/** 脚本化的假文本生成端口；同时是文本生成来源，所有作品都返回它自己。 */
export class ScriptedText implements TextGenerationPort, TextGenerationSource {
  readonly requests: TextGenerationRequest[] = [];
  /** 每次取端口时指定的文本模型键，没有指定为 null。 */
  readonly modelKeys: Array<string | null> = [];

  forWork(_workId?: number | null, modelKey?: string | null): TextGenerationPort {
    this.modelKeys.push(modelKey ?? null);
    return this;
  }
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

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<unknown> {
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

/** 默认响应：按请求中的任务标题返回符合要求的结果对象。 */
export function standardResponder(request: TextGenerationRequest): unknown {
  const user = request.user;
  if (user.includes('# 任务：提取原文要点')) {
    return { summary: `要点${/第 (\d+) 段/.exec(user)?.[1] ?? ''}` };
  }
  if (user.includes('# 任务：分析灵感图片')) {
    return { summary: '画面：灯塔与海' };
  }
  if (user.includes('# 任务：规划章节大纲')) {
    return {
      chapters: [
        { title: '开端', summary: '守夜人上岗', sources: [1] },
        { title: '转折', summary: '收到信号', sources: [2] },
        { title: '结局', summary: '真相', sources: [3] }
      ]
    };
  }
  const chapter = /# 任务：撰写第 (\d+) 章/.exec(user);
  if (chapter !== null) {
    return { title: `第${chapter[1]}章`, content: '灯'.repeat(120) };
  }
  if (user.includes('# 任务：撰写剧本包')) {
    return { title: '雨夜来客', overview: '灯塔守夜人在雨夜收到神秘信号。', fullText: '场景一 灯塔内 夜\n守夜人点亮灯塔。\n老陈：今晚会下雨。' };
  }
  if (user.includes('# 任务：从剧本中抽取集和实体')) {
    // 多集短片的集需要标题和本集正文，单个短视频不需要，以工具参数的字段区分。
    const series = JSON.stringify(request.tool.inputSchema).includes('"screenplayText"');
    return {
      episodes: series
        ? [
            { title: '第一集', synopsis: '开端', screenplayText: '第一集正文', targetDurationSeconds: 30 },
            { title: '第二集', synopsis: '转折', screenplayText: '第二集正文', targetDurationSeconds: 30 }
          ]
        : [{ synopsis: '守夜人的雨夜', targetDurationSeconds: 30 }],
      entities: [
        { kind: 'character', name: '守夜人', aliases: ['老陈'], description: '灯塔守夜人', attributes: { identity: '守灯塔三十年', voice: '低沉' } },
        { kind: 'scene', name: '灯塔', description: '海边灯塔', attributes: { interior_exterior: '内景' } }
      ]
    };
  }
  if (user.includes('# 任务：生成分镜脚本')) {
    // 声音类型、首帧来源随生成参数裁剪，以工具参数的字段区分。
    const schema = JSON.stringify(request.tool.inputSchema);
    const withSounds = schema.includes('"sounds"');
    const withFirstFrame = schema.includes('"firstFrameMode"');
    const shot = (index: number, entities: unknown[], sounds: unknown[]): Record<string, unknown> => ({
      sceneLabel: '第01场',
      shotSize: index === 1 ? '远景' : '特写',
      cameraAngle: '平视',
      action: index === 1 ? '雨夜里的灯塔亮起光' : '守夜人抬头望向海面',
      cameraMovement: '固定',
      durationSeconds: 4,
      transition: '切',
      continuityNote: '雨夜、冷色调',
      ...(withFirstFrame ? { firstFrameMode: index === 1 ? 'none' : 'prev_tail' } : {}),
      entities,
      ...(withSounds ? { sounds } : {}),
      promptZh: '雨夜的灯塔',
      promptEn: 'A lighthouse on a rainy night'
    });
    return {
      shots: [
        shot(1, [{ kind: 'scene', name: '灯塔' }], [{ kind: 'music', text: '紧张的弦乐', delivery: '低沉' }]),
        shot(2, [{ kind: 'character', name: '老陈' }], [{ kind: 'dialogue', speaker: '老陈', text: '今晚会下雨。', delivery: '低声' }])
      ]
    };
  }
  throw new Error(`未预期的请求：${user.slice(0, 40)}`);
}
