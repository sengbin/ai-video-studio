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
  /** 实现必须强制模型通过该工具返回，工具参数对象即生成结果；模型没有通过工具返回时抛出错误。 */
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
}

/** 按作品提供文本生成端口：本次生成可以指定文本模型，其次是作品单独选择的模型，都没有时使用全局默认。 */
export interface TextGenerationSource {
  /**
   * 取得某个作品使用的文本生成端口；返回的端口在 resolveModel 时按当时的设置选定模型，之后的调用沿用该选择。
   * @param workId 作品标识；null 表示不属于任何作品（如资产提示词）。
   * @param modelKey 本次生成指定的文本模型键；缺省或 null 时依次使用作品单独选择的模型、全局默认。指定的模型不可用时同样依次回退。
   */
  forWork(workId: number | null, modelKey?: string | null): TextGenerationPort;
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
   * 发送请求并返回模型通过输出工具提交的参数对象，内容未经校验。
   * @throws TextGenerationError 调用失败、被拒绝、被限流、已取消或没有通过工具返回。
   */
  generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<unknown>;
}
