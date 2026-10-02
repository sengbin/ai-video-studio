// ------------------------------------------------------------------------
// 名称：video-request.ts
// 说明：把任务请求快照与素材内容组装成与模型无关的视频生成请求，供提交前校验和队列提交共用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：素材已被删除时抛出参数类错误，提示用户重新绑定。
// ------------------------------------------------------------------------

import { ProviderError } from '../../domain/errors';
import { JobSnapshot } from '../../domain/models/generation';
import { JobMediaReader } from '../../domain/ports/generation-repository';
import { MediaInput, VideoGenerationRequest } from '../../domain/ports/provider-adapters';

/**
 * 按快照读取素材内容并组装生成请求。
 * @param snapshot 任务请求快照。
 * @param firstFrameId 作为首帧的尾帧图片标识；没有首帧为 null。
 * @param media 素材读取器。
 * @param modelCode 服务商侧的模型代码。
 * @throws ProviderError 参考素材或首帧图片已不存在（分类为参数错误）。
 */
export function buildVideoRequest(snapshot: JobSnapshot, firstFrameId: number | null, media: JobMediaReader, modelCode: string): VideoGenerationRequest {
  const loadAll = (ids: readonly number[]): MediaInput[] =>
    ids.map((id) => {
      const file = media.readAssetFile(id);
      if (file === undefined) {
        throw new ProviderError('invalid_request', '参考素材已被删除，请重新绑定资产后再生成。');
      }
      return file;
    });
  let firstFrame: MediaInput | null = null;
  if (firstFrameId !== null) {
    firstFrame = media.readResultFrame(firstFrameId) ?? null;
    if (firstFrame === null) {
      throw new ProviderError('invalid_request', '首帧图片已不存在，请重新生成前序镜头。');
    }
  }
  return {
    modelCode,
    prompt: snapshot.prompt,
    firstFrame,
    lastFrame: null,
    referenceImages: loadAll(snapshot.referenceImageFileIds),
    referenceAudios: loadAll(snapshot.referenceAudioFileIds),
    aspectRatio: snapshot.params.aspectRatio,
    resolution: snapshot.params.resolution,
    durationSeconds: snapshot.params.durationSeconds,
    audioMode: snapshot.params.audioMode,
    seed: snapshot.params.seed,
    extraParams: snapshot.params.extraParams
  };
}
