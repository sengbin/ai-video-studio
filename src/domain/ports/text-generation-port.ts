// ------------------------------------------------------------------------
// 名称：text-generation-port.ts
// 说明：文本生成的端口接口：阶段执行器通过它调用 Copilot，领域层不依赖 VS Code。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：失败一律抛出 TextGenerationError；测试中用假实现替代。
// ------------------------------------------------------------------------

/** 随请求发送的图片。 */
export interface ImageInput {
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/** 用于强制结构化输出的工具：模型必须调用它，工具参数即结果对象。 */
export interface OutputTool {
  readonly name: string;
  readonly description: string;
  /** 参数的 JSON Schema，顶层必须是对象。 */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 一次文本生成请求：系统段、用户段（含素材）、可选图片和输出工具。 */
export interface TextGenerationRequest {
  readonly system: string;
  readonly user: string;
  readonly images?: readonly ImageInput[];
  /** 实现必须强制模型通过该工具返回，并把工具参数序列化为 JSON 文本作为输出；模型没有通过工具返回时抛出错误。 */
  readonly tool: OutputTool;
}

/** 生成过程中的附加选项。 */
export interface TextGenerationOptions {
  /** 取消信号；触发后应尽快终止并抛出 category 为 canceled 的错误。 */
  readonly signal?: AbortSignal;
}

/** 当前使用的文本模型信息。 */
export interface TextModelInfo {
  /** 用于记录到阶段记录的标识，如“copilot/gpt-4o”。 */
  readonly id: string;
  /** 最大输入 token 数，用于分段预算。 */
  readonly maxInputTokens: number;
  /** 是否支持图片输入。 */
  readonly supportsImageInput: boolean;
}

/** 文本生成端口。 */
export interface TextGenerationPort {
  /**
   * 按设置选出要使用的模型。
   * @throws TextGenerationError 没有可用模型（未安装、未登录等）。
   */
  resolveModel(): Promise<TextModelInfo>;
  /** 估算文本占用的 token 数。 */
  countTokens(text: string): Promise<number>;
  /**
   * 发送请求并返回完整的文本输出。
   * @throws TextGenerationError 调用失败、被拒绝、被限流或已取消。
   */
  generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<string>;
}
