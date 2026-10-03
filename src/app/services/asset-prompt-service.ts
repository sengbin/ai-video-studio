// ------------------------------------------------------------------------
// 名称：asset-prompt-service.ts
// 说明：资产提示词的后台生成服务：创建后或手动触发时，在后台调用 Copilot 生成中英文提示词，状态保存在资产上，支持取消与重启恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一个资产同时只有一个任务；生成依据开始时已保存的内容，完成后提示词记录的是开始时的表单修订号，期间改了表单会显示“需更新”；不自动重试。
// ------------------------------------------------------------------------

import { NotFoundError, TextGenerationError, ValidationError, FORM_LEVEL_ERROR_KEY } from '../../domain/errors';
import { AssetRecord } from '../../domain/models/asset';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ImageInput, TextGenerationPort } from '../../domain/ports/text-generation-port';
import { UPLOAD_SOURCE_GENERATION_MESSAGE } from '../../domain/rules/asset-generation-rules';
import {
  ASSET_PROMPT_IMAGE_MAX_BYTES,
  ASSET_PROMPT_MAX_IMAGES,
  assetToDraftValues,
  describeAssetDraft,
  parseAssetPrompts,
  promptFocus,
  promptKindLabel
} from '../../domain/rules/asset-prompt-rules';
import { detectImageMime } from '../../domain/rules/work-rules';
import { askModel } from '../stages/ask-model';
import { SUBMIT_ASSET_PROMPTS_TOOL } from '../stages/output-tools/asset-prompt-output-tools';
import { wrapMaterial } from '../stages/prompt-templates';
import { InvalidOutputError } from '../stages/structured-generation';

/** 资产提示词模板使用的变量，模板文件必须与之完全一致（测试校验）。 */
export const ASSET_PROMPT_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  'asset-prompt': ['kindLabel', 'material', 'imageNote', 'focus'],
  'asset-audio-prompt': ['kindLabel', 'material', 'focus']
};

/** 信息不足、无法生成提示词时的提示。 */
export const NO_PROMPT_DETAIL_MESSAGE = '请先填写名称，并至少填写一项描述（图像类也可以添加一张参考图），再生成提示词。';

const INTERRUPTED_MESSAGE = '扩展重启，已中断。';
const ALREADY_RUNNING_MESSAGE = '提示词正在生成中。';

/** 资产提示词服务的依赖。 */
export interface AssetPromptServiceDependencies {
  readonly text: TextGenerationPort;
  readonly prompts: PromptTemplates;
  readonly assets: AssetRepository;
  /** 提示词状态变化后通知界面刷新。 */
  readonly notify: () => void;
  readonly now?: () => Date;
}

/** 资产提示词后台生成服务。 */
export class AssetPromptService {
  private readonly running = new Map<number, AbortController>();
  private readonly now: () => Date;

  constructor(private readonly dependencies: AssetPromptServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * 检查草稿是否有足够的信息生成提示词：有名称，且至少有一项描述或一张参考图。
   * @param asset 资产或还没有保存的草稿内容。
   * @throws ValidationError 信息不足。
   */
  assertCanGenerate(kind: AssetRecord['kind'], values: Readonly<Record<string, unknown>>, hasImages: boolean): void {
    const draft = describeAssetDraft(kind, values);
    if (draft.name === '' || (draft.detailCount === 0 && !hasImages)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_PROMPT_DETAIL_MESSAGE });
    }
  }

  /**
   * 启动后台生成：立即返回，生成在后台进行，状态与结果保存在资产上。
   * @returns done 在后台任务结束（成功、失败或取消）后完成，从不拒绝，供测试等待。
   * @throws NotFoundError 资产不存在。
   * @throws ValidationError 信息不足，或已在生成中。
   */
  start(assetId: number): { readonly done: Promise<void> } {
    const { assets } = this.dependencies;
    const asset = assets.findById(assetId);
    if (asset === undefined) {
      throw new NotFoundError(`资产 ${assetId} 不存在。`);
    }
    // 使用上传文件的资产没有生成入口，要生成须先改用生成。
    if (asset.fileSource === 'upload') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: UPLOAD_SOURCE_GENERATION_MESSAGE });
    }
    const images = this.readImages(asset);
    this.assertCanGenerate(asset.kind, assetToDraftValues(asset), images.length > 0);
    if (!assets.beginPrompt(assetId, this.timestamp())) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: ALREADY_RUNNING_MESSAGE });
    }
    this.dependencies.notify();
    const controller = new AbortController();
    this.running.set(assetId, controller);
    return { done: this.run(asset, images, controller) };
  }

  /**
   * 取消正在进行的提示词生成：先把状态落库为“已取消”（界面显示“已取消”，重启后不会被改写成别的失败原因），再中止后台任务；
   * 任务被中止后不会再写回结果。没有进行中的任务时不做任何事。
   */
  cancel(assetId: number): void {
    const controller = this.running.get(assetId);
    if (controller === undefined) {
      return;
    }
    // 先摘掉任务登记并落库，之后即使模型调用没有及时响应中止，也不会再改写状态，且可以立即重新生成。
    this.running.delete(assetId);
    this.dependencies.assets.endPrompt(assetId, 'canceled', null, this.timestamp());
    controller.abort();
    this.dependencies.notify();
  }

  /** 扩展启动时调用：遗留的生成中任务无法继续，置为失败。返回处理的数量。 */
  recoverInterrupted(): number {
    const { assets } = this.dependencies;
    let count = 0;
    for (const id of assets.listPromptRunning()) {
      if (!this.running.has(id) && assets.endPrompt(id, 'failed', INTERRUPTED_MESSAGE, this.timestamp())) {
        count += 1;
      }
    }
    return count;
  }

  /** 执行一次生成并把结果写回资产。 */
  private async run(asset: AssetRecord, images: readonly ImageInput[], controller: AbortController): Promise<void> {
    const { text, prompts, assets } = this.dependencies;
    try {
      const model = await text.resolveModel();
      const draft = describeAssetDraft(asset.kind, assetToDraftValues(asset));
      const common = { kindLabel: promptKindLabel(asset), material: wrapMaterial(draft.lines.join('\n')), focus: promptFocus(asset) };
      const isAudio = asset.kind === 'audio';
      const result = await askModel(
        { model, text, signal: controller.signal },
        prompts,
        isAudio ? 'asset-audio-prompt' : 'asset-prompt',
        isAudio
          ? common
          : {
              ...common,
              imageNote:
                images.length === 0
                  ? ''
                  : `## 参考图\n\n已附 ${images.length} 张参考图：提取其中的外观、材质和风格作为依据；与上面的文字设定冲突时，以文字设定为准。`
            },
        parseAssetPrompts,
        { images, overflowHint: '请精简描述字段后重试。', tool: SUBMIT_ASSET_PROMPTS_TOOL }
      );
      if (controller.signal.aborted) {
        return; // 已被取消，状态在取消时已落库，不再写回结果。
      }
      assets.finishPrompt(asset.id, result, asset.contentRevision, this.timestamp());
    } catch (error) {
      if (controller.signal.aborted) {
        return; // 已被取消，状态在取消时已落库，不用失败原因覆盖。
      }
      const canceled = error instanceof TextGenerationError && error.category === 'canceled';
      assets.endPrompt(asset.id, canceled ? 'canceled' : 'failed', canceled ? null : describeFailure(error), this.timestamp());
    } finally {
      // 取消后可能已有新任务占用同一资产，只摘除自己登记的控制器。
      if (this.running.get(asset.id) === controller) {
        this.running.delete(asset.id);
      }
      this.dependencies.notify();
    }
  }

  /** 取资产的参考图作为模型输入：最多取前几张；原文件太大时改发缩略图。 */
  private readImages(asset: AssetRecord): ImageInput[] {
    if (asset.kind === 'audio') {
      return [];
    }
    const { assets } = this.dependencies;
    const references = assets.listReferenceFiles(asset.id).slice(0, ASSET_PROMPT_MAX_IMAGES);
    if (references.length === 0) {
      return [];
    }
    const thumbnails = assets.listThumbnailFiles(asset.id);
    const images: ImageInput[] = [];
    for (const file of references) {
      const source = file.content.length > ASSET_PROMPT_IMAGE_MAX_BYTES ? (thumbnails.find((item) => item.sortOrder === file.sortOrder) ?? file) : file;
      const mimeType = detectImageMime(source.content);
      if (mimeType !== null) {
        images.push({ mimeType, data: source.content });
      }
    }
    return images;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** 把失败转换为给用户看的原因。 */
function describeFailure(error: unknown): string {
  if (error instanceof InvalidOutputError) {
    return `${error.message} 请重试。`;
  }
  if (error instanceof TextGenerationError) {
    return error.message;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `内部错误：${detail}`;
}
