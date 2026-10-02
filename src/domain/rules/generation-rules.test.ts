// ------------------------------------------------------------------------
// 名称：generation-rules.test.ts
// 说明：视频生成规则的自动化测试：提交请求的读取、时长调整、镜头编译为提示词与快照、失败原因说明。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数测试，使用假视频模型的能力。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../errors';
import { GenerationParams } from '../models/generation';
import { VideoCapability } from '../models/model-capability';
import { ShotRecord, SoundRecord } from '../models/storyboard';
import { FAKE_VIDEO_CAPABILITY } from '../ports/testing/fake-model-providers';
import { EntityReferences, describeJobFailure, fitDuration, planShotRequest, readSubmitInput } from './generation-rules';

const PARAMS: GenerationParams = { modelId: 1, aspectRatio: '16:9', resolution: '720P', audioMode: null };

function sound(overrides: Partial<SoundRecord>): SoundRecord {
  return { id: 1, kind: 'dialogue', speakerEntityId: null, text: '台词', delivery: '', startOffsetSeconds: null, durationSeconds: null, isEnabled: true, ...overrides };
}

function shot(overrides: Partial<ShotRecord> = {}): ShotRecord {
  return {
    id: 10,
    seq: 1,
    sceneLabel: '第01场',
    shotSize: '中景',
    cameraAngle: '平视',
    action: '守夜人登上灯塔',
    cameraMovement: '推',
    durationSeconds: 5,
    transition: '',
    continuityNote: '',
    firstFrameMode: 'none',
    entityIds: [],
    sounds: [],
    promptZh: '中景，守夜人缓缓登上灯塔',
    promptEn: 'A watchman climbs the lighthouse',
    ...overrides
  };
}

function plan(shotOverrides: Partial<ShotRecord>, entities: EntityReferences[] = [], capability: VideoCapability = FAKE_VIDEO_CAPABILITY, params = PARAMS) {
  return planShotRequest({ shot: shot(shotOverrides), storyboardRunId: 3, providerCode: 'fake', modelCode: 'fake-video', capability, params, entities });
}

const GUARD: EntityReferences = { entityId: 1, name: '守夜人', kind: 'character', visualFileId: 101, voiceFileId: null };

test('读取提交请求：去重镜头，可选参数为空时取 null', () => {
  const input = readSubmitInput({ workId: 1, episodeId: 2, shotIds: [5, 5, 6], params: { modelId: 3, aspectRatio: '', resolution: '720P' } });
  assert.deepEqual(input, { workId: 1, episodeId: 2, shotIds: [5, 6], params: { modelId: 3, aspectRatio: null, resolution: '720P', audioMode: null } });
});

test('读取提交请求：标识、镜头数量、声音模式不合法时报错', () => {
  const base = { workId: 1, episodeId: 2, shotIds: [5], params: { modelId: 3 } };
  const rejected = (input: unknown) => assert.throws(() => readSubmitInput(input), ValidationError);
  rejected(null);
  rejected({ ...base, workId: 'x' });
  rejected({ ...base, episodeId: 1.5 });
  rejected({ ...base, shotIds: [] });
  rejected({ ...base, shotIds: ['a'] });
  rejected({ ...base, shotIds: Array.from({ length: 201 }, (_, index) => index) });
  rejected({ ...base, params: {} });
  rejected({ ...base, params: { modelId: 3, audioMode: 'external' } });
  rejected({ ...base, params: { modelId: 3, resolution: 'x'.repeat(21) } });
});

test('时长调整：步长取整、夹到范围、可选值取最近', () => {
  assert.deepEqual(fitDuration({ min: 2, max: 10, step: 1 }, 3.4), { seconds: 3, adjusted: true });
  assert.deepEqual(fitDuration({ min: 2, max: 10, step: 1 }, 4), { seconds: 4, adjusted: false });
  assert.deepEqual(fitDuration({ min: 2, max: 10, step: 1 }, 1), { seconds: 2, adjusted: true });
  assert.deepEqual(fitDuration({ min: 2, max: 10, step: 1 }, 40), { seconds: 10, adjusted: true });
  assert.deepEqual(fitDuration({ options: [5, 10] }, 7.4), { seconds: 5, adjusted: true });
  assert.deepEqual(fitDuration({ options: [5, 10] }, 8), { seconds: 10, adjusted: true });
  assert.deepEqual(fitDuration({ max: 8 }, 12), { seconds: 8, adjusted: true });
});

test('编译镜头：使用中文提示词、调整时长，默认原生声音并记录快照', () => {
  const snapshot = plan({ durationSeconds: 3.6 });
  assert.equal(snapshot.prompt, '中景，守夜人缓缓登上灯塔');
  assert.deepEqual(snapshot.params, { aspectRatio: '16:9', resolution: '720P', durationSeconds: 4, audioMode: 'native', seed: null, extraParams: {} });
  assert.deepEqual([snapshot.storyboardRunId, snapshot.providerCode, snapshot.modelCode], [3, 'fake', 'fake-video']);
  assert.match(snapshot.warnings.join(), /已调整为 4 秒/);
});

test('编译镜头：提示词语言取决于模型，中文为空时退回画面描述', () => {
  const englishOnly = { ...FAKE_VIDEO_CAPABILITY, promptLanguages: ['en' as const] };
  assert.equal(plan({}, [], englishOnly).prompt, 'A watchman climbs the lighthouse');
  assert.equal(plan({ promptZh: '  ' }).prompt, '守夜人登上灯塔');
  assert.equal(plan({ promptZh: '', promptEn: '' }, [], englishOnly).prompt, '守夜人登上灯塔');
});

test('编译镜头：参考图编号写入提示词，未绑定的实体给出提醒，超出上限的忽略', () => {
  const lighthouse: EntityReferences = { entityId: 2, name: '灯塔', kind: 'scene', visualFileId: 102, voiceFileId: null };
  const unbound: EntityReferences = { entityId: 3, name: '旧钥匙', kind: 'prop', visualFileId: null, voiceFileId: null };
  const snapshot = plan({}, [GUARD, lighthouse, unbound]);
  assert.deepEqual(snapshot.referenceImageFileIds, [101, 102]);
  assert.ok(snapshot.prompt.startsWith('图1是角色“守夜人”的形象参考。图2是场景“灯塔”的形象参考。\n中景'));
  assert.ok(snapshot.warnings.some((warning) => warning.includes('道具“旧钥匙”还没有绑定资产')));

  const tight = { ...FAKE_VIDEO_CAPABILITY, referenceImagesMax: 1 };
  const limited = plan({}, [GUARD, lighthouse], tight);
  assert.deepEqual(limited.referenceImageFileIds, [101]);
  assert.ok(limited.warnings.some((warning) => warning.includes('最多支持 1 张参考图')));
});

test('编译镜头：原生声音把启用的条目写入提示词，模型不支持的内容忽略并提醒', () => {
  const sounds = [
    sound({ id: 1, kind: 'dialogue', speakerEntityId: 1, text: '要下雨了', delivery: '低声' }),
    sound({ id: 2, kind: 'narration', text: '夜深了' }),
    sound({ id: 3, kind: 'sfx', text: '海浪声', delivery: '远处' }),
    sound({ id: 4, kind: 'music', text: '弦乐' }),
    sound({ id: 5, kind: 'dialogue', speakerEntityId: 1, text: '已关闭', isEnabled: false })
  ];
  const snapshot = plan({ sounds }, [GUARD]);
  // 假模型只支持对白和音效。
  assert.ok(snapshot.prompt.endsWith('声音：守夜人（低声）说：“要下雨了”；音效：海浪声（远处）'));
  assert.ok(!snapshot.prompt.includes('已关闭') && !snapshot.prompt.includes('夜深了'));
  assert.ok(snapshot.warnings.includes('模型不支持部分声音内容，已忽略。'));
});

test('编译镜头：选择无声时不写声音提示词；音色参考只给有对白的角色且受模型支持', () => {
  const sounds = [sound({ kind: 'dialogue', speakerEntityId: 1, text: '要下雨了' })];
  const silent = plan({ sounds }, [GUARD], FAKE_VIDEO_CAPABILITY, { ...PARAMS, audioMode: 'none' });
  assert.ok(!silent.prompt.includes('声音：'));
  assert.equal(silent.params.audioMode, 'none');

  const voiced: EntityReferences = { ...GUARD, voiceFileId: 201 };
  const withVoiceModel = { ...FAKE_VIDEO_CAPABILITY, voiceReference: true, audioInputMax: { count: 2, maxSeconds: 15 } };
  const supported = plan({ sounds }, [voiced], withVoiceModel);
  assert.deepEqual(supported.referenceAudioFileIds, [201]);
  assert.ok(supported.prompt.includes('音频1是角色“守夜人”的音色参考。'));
  assert.deepEqual(plan({ sounds }, [voiced]).referenceAudioFileIds, [], '模型不支持参考音频');
  assert.deepEqual(plan({}, [voiced], withVoiceModel).referenceAudioFileIds, [], '没有对白不需要音色参考');
});

test('编译镜头：尾帧衔接与指定图片首帧本版本不支持，给出提醒但不阻断', () => {
  assert.match(plan({ firstFrameMode: 'prev_tail' }).warnings.join(), /上一镜头尾帧作首帧.*尚未开放/);
  assert.match(plan({ firstFrameMode: 'asset' }).warnings.join(), /指定图片作首帧.*尚未开放/);
  assert.deepEqual(plan({ firstFrameMode: 'none' }).warnings, []);
});

test('失败原因说明：每一类都有名称与处理建议，内容审核类指引修改镜头', () => {
  const categories = ['auth', 'rate_limited', 'invalid_request', 'content_rejected', 'server', 'network'] as const;
  for (const category of categories) {
    const described = describeJobFailure({ category, code: null, message: 'm' });
    assert.ok(described.label !== '' && described.hint !== '');
  }
  const rejected = describeJobFailure({ category: 'content_rejected', code: 'DataInspectionFailed', message: 'x' });
  assert.equal(rejected.label, '内容审核未通过');
  assert.match(rejected.hint, /编辑镜头/);
});
