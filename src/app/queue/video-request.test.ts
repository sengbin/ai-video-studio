// ------------------------------------------------------------------------
// 名称：video-request.test.ts
// 说明：视频生成请求组装的自动化测试：任务快照里的画幅、分辨率、时长、声音模式与随机种子原样带入请求，素材已被删除时报参数类错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数测试，素材读取器用内存假实现。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../domain/errors';
import { JobSnapshot } from '../../domain/models/generation';
import { JobMediaReader } from '../../domain/ports/generation-repository';
import { MediaInput } from '../../domain/ports/provider-adapters';
import { buildVideoRequest } from './video-request';

const FILE: MediaInput = { mimeType: 'image/png', data: new Uint8Array([1]) };

/** 只认 id 为 1 的资产文件；没有结果尾帧。 */
const MEDIA: JobMediaReader = {
  readAssetFile: (id) => (id === 1 ? FILE : undefined),
  readResultFrame: () => undefined
};

function snapshot(overrides: Partial<JobSnapshot['params']> = {}, referenceImageFileIds: number[] = []): JobSnapshot {
  return {
    storyboardRunId: 1,
    shotIds: [1],
    providerCode: 'fake',
    modelCode: 'fake-video',
    prompt: '提示词',
    params: { aspectRatio: '16:9', resolution: '720P', durationSeconds: 8, audioMode: 'native', audioElements: ['dialogue'], seed: 42, extraParams: {}, ...overrides },
    referenceImageFileIds,
    referenceAudioFileIds: [],
    warnings: []
  };
}

test('组装请求：快照里的画幅、分辨率、时长、声音模式、种子原样带入，种子为空时不指定', () => {
  const request = buildVideoRequest(snapshot(), null, MEDIA, 'fake-video');
  assert.deepEqual(
    [request.modelCode, request.prompt, request.aspectRatio, request.resolution, request.durationSeconds, request.audioMode, request.seed],
    ['fake-video', '提示词', '16:9', '720P', 8, 'native', 42]
  );
  assert.equal(buildVideoRequest(snapshot({ seed: null }), null, MEDIA, 'fake-video').seed, null);
  assert.equal(buildVideoRequest(snapshot({ seed: 0 }), null, MEDIA, 'fake-video').seed, 0, '种子 0 是有效值');
});

test('组装请求：参考素材已被删除时抛出参数类错误', () => {
  assert.equal(buildVideoRequest(snapshot({}, [1]), null, MEDIA, 'fake-video').referenceImages.length, 1);
  assert.throws(
    () => buildVideoRequest(snapshot({}, [2]), null, MEDIA, 'fake-video'),
    (error) => error instanceof ProviderError && error.category === 'invalid_request'
  );
});

test('组装请求：快照指定了首帧图片时读取资产图片作首帧，图片已被删除或替换时抛出参数类错误；尾帧优先于它', () => {
  assert.equal(buildVideoRequest({ ...snapshot(), firstFrameFileId: 1 }, null, MEDIA, 'fake-video').firstFrame, FILE);
  assert.equal(buildVideoRequest(snapshot(), null, MEDIA, 'fake-video').firstFrame, null);
  assert.throws(
    () => buildVideoRequest({ ...snapshot(), firstFrameFileId: 2 }, null, MEDIA, 'fake-video'),
    (error) => error instanceof ProviderError && error.category === 'invalid_request' && error.message.includes('首帧图片')
  );
  const frame: MediaInput = { mimeType: 'image/jpeg', data: new Uint8Array([9]) };
  const withFrame: JobMediaReader = { ...MEDIA, readResultFrame: () => frame };
  assert.equal(buildVideoRequest({ ...snapshot(), firstFrameFileId: 1 }, 5, withFrame, 'fake-video').firstFrame, frame);
});