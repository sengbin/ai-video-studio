// ------------------------------------------------------------------------
// 名称：asset-prompt-service.ts
// 说明：资产提示词生成服务：把表单草稿（及参考图）交给 Copilot，返回中英文提示词，不写库。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：草稿来自尚未保存的表单；用户检查、修改并保存即视为确认；不自动重试，输出不合格以文本生成错误告知用户。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, TextGenerationError, ValidationError } from '../../domain/errors';
import { ASSET_KIND_LABELS, AssetKind } from '../../domain/models/asset';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ImageInput, TextGenerationPort } from '../../domain/ports/text-generation-port';
import {
  ASSET_PROMPT_FOCUS,
  ASSET_PROMPT_MAX_IMAGES,
  AssetPrompts,
  describeAssetDraft,
  isPromptAssetKind,
  parseAssetPrompts
} from '../../domain/rules/asset-prompt-rules';
import { ASSET_FILE_FIELD_KEY, ASSET_IMAGE_MAX_BYTES } from '../../domain/rules/asset-rules';
import { FieldErrors } from '../../domain/rules/field-readers';
import { readUploadedFiles } from '../../domain/rules/upload-readers';
import { detectImageMime } from '../../domain/rules/work-rules';
import { askModel } from '../stages/ask-model';
import { SUBMIT_ASSET_PROMPTS_TOOL } from '../stages/output-tools/asset-prompt-output-tools';
import { InvalidOutputError } from '../stages/structured-generation';
import { wrapMaterial } from '../stages/prompt-templates';
import { ProjectService } from './project-service';

const NO_DETAIL_MESSAGE = '请先填写名称，并至少填写一项描述或添加一张参考图，再生成提示词。';
const AUDIO_MESSAGE = '音频资产没有提示词。';

/** 资产提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const ASSET_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  'asset-prompt': ['kindLabel', 'material', 'imageNote', 'focus']
};

/** 一次生成请求。 */
export interface AssetPromptRequest {
  readonly kind: AssetKind;
  /** 表单当前值；参考图字段只带最多几张已缩小的图片。 */
  readonly values: Readonly<Record<string, unknown>>;
  /** 资产所属项目；尚未选择项目时为 undefined，此时画面风格只取资产自己的设置。 */
  readonly projectId?: number;
}

/** 资产提示词生成服务。 */
export class AssetPromptService {
  constructor(
    private readonly dependencies: {
      readonly text: TextGenerationPort;
      readonly prompts: PromptTemplates;
      readonly projects: ProjectService;
    }
  ) {}

  /**
   * 生成中英文提示词。
   * @param request 资产类型、表单草稿和所属项目。
   * @param signal 取消信号。
   * @throws ValidationError 类型不支持、草稿信息不足或参考图格式不对。
   * @throws TextGenerationError 模型不可用、调用失败、被拒绝、已取消，或输出不符合要求。
   */
  async generate(request: AssetPromptRequest, signal: AbortSignal): Promise<AssetPrompts> {
    const { kind, values } = request;
    if (!isPromptAssetKind(kind)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: AUDIO_MESSAGE });
    }
    const { text, prompts, projects } = this.dependencies;
    const projectStyle = request.projectId === undefined ? null : (projects.findProject(request.projectId)?.visualStyle ?? null);
    const images = readReferenceImages(values[ASSET_FILE_FIELD_KEY]);
    const draft = describeAssetDraft(kind, values, projectStyle);
    if (draft.name.length === 0 || (draft.detailCount === 0 && images.length === 0)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_DETAIL_MESSAGE });
    }

    const model = await text.resolveModel();
    try {
      return await askModel(
        { model, text, signal },
        prompts,
        'asset-prompt',
        {
          kindLabel: ASSET_KIND_LABELS[kind],
          material: wrapMaterial(draft.lines.join('\n')),
          imageNote:
            images.length === 0
              ? ''
              : `## 参考图\n\n已附 ${images.length} 张参考图：提取其中的外观、材质和风格作为依据；与上面的文字设定冲突时，以文字设定为准。`,
          focus: ASSET_PROMPT_FOCUS[kind]
        },
        parseAssetPrompts,
        { images, overflowHint: '请精简描述字段后重试。', tool: SUBMIT_ASSET_PROMPTS_TOOL }
      );
    } catch (error) {
      if (error instanceof InvalidOutputError) {
        throw new TextGenerationError('failed', `${error.message} 请重试。`, { cause: error });
      }
      throw error;
    }
  }
}

/** 读取表单带来的参考图：最多取前几张，按文件头识别格式；格式不对时报参考图字段错误。 */
function readReferenceImages(value: unknown): ImageInput[] {
  const errors: FieldErrors = {};
  const files = readUploadedFiles(value, ASSET_FILE_FIELD_KEY, '参考图', ASSET_IMAGE_MAX_BYTES, errors) ?? [];
  const images: ImageInput[] = [];
  for (const file of files.slice(0, ASSET_PROMPT_MAX_IMAGES)) {
    const mimeType = detectImageMime(file.content);
    if (mimeType === null) {
      errors[ASSET_FILE_FIELD_KEY] = `“${file.name}”不是有效的 PNG、JPEG 或 WebP 图片。`;
      break;
    }
    images.push({ mimeType, data: file.content });
  }
  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
  return images;
}
