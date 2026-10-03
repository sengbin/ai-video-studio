// ------------------------------------------------------------------------
// 名称：generation-rules.test.ts
// 说明：视频生成规则的自动化测试：提交请求的读取、组时长对齐、镜头组编译为带时间段的提示词与快照、失败原因说明。
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
import {
  EntityReferences,
  PREVIOUS_GROUP_UNAVAILABLE_CODE,
  TAIL_FRAME_UNAVAILABLE_CODE,
  describeJobFailure,
  fitGroupDuration,
  formatTimestamp,
  maxGroupSeconds,
  planGroupRequest,
  readSubmitInput,
  readTailFrameFailure,
  readTailFrameInput,
  validateGroupParams
} from './generation-rules';

const PARAMS: GenerationParams = { modelId: 1, aspectRatio: '16:9', resolution: '720P', audioMode: null, audioElements: null, seed: null, durationSeconds: null };

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
    firstFrameAssetId: null,
    entityIds: [],
    sounds: [],
    promptZh: '中景，守夜人缓缓登上灯塔',
    promptEn: 'A watchman climbs the lighthouse',
    ...overrides
  };
}

function plan(shotOverrides: Partial<ShotRecord>, entities: EntityReferences[] = [], capability: VideoCapability = FAKE_VIDEO_CAPABILITY, params = PARAMS) {
  return planMany([shot(shotOverrides)], entities, capability, params);
}

function planMany(shots: ShotRecord[], entities: EntityReferences[] = [], capability: VideoCapability = FAKE_VIDEO_CAPABILITY, params = PARAMS) {
  return planGroupRequest({ shots, storyboardRunId: 3, providerCode: 'fake', modelCode: 'fake-video', capability, params, entities });
}

const GUARD: EntityReferences = { entityId: 1, name: '守夜人', kind: 'character', visualFileId: 101, voiceFileId: null };

test('读取提交请求：去重镜头组，可选参数为空时取 null', () => {
  const input = readSubmitInput({ workId: 1, episodeId: 2, groupIds: [5, 5, 6], params: { modelId: 3, aspectRatio: '', resolution: '720P' } });
  assert.deepEqual(input, {
    workId: 1,
    episodeId: 2,
    groupIds: [5, 6],
    params: { modelId: 3, aspectRatio: null, resolution: '720P', audioMode: null, audioElements: null, seed: null, durationSeconds: null }
  });
});

test('读取提交请求：声音内容去重并按固定顺序排列，种子取整数；不合法时指出字段', () => {
  const read = (params: Record<string, unknown>) => readSubmitInput({ workId: 1, episodeId: 2, groupIds: [5], params: { modelId: 3, ...params } }).params;
  const parsed = read({ audioElements: ['sfx', 'dialogue', 'sfx'], seed: 0 });
  assert.deepEqual(parsed.audioElements, ['dialogue', 'sfx']);
  assert.equal(parsed.seed, 0);
  const fieldOf = (params: Record<string, unknown>): string[] => {
    try {
      read(params);
    } catch (error) {
      if (error instanceof ValidationError) return Object.keys(error.fieldErrors);
    }
    return [];
  };
  assert.deepEqual(fieldOf({ audioElements: [] }), ['audioElements']);
  assert.deepEqual(fieldOf({ audioElements: ['voice'] }), ['audioElements']);
  assert.deepEqual(fieldOf({ seed: -1 }), ['seed']);
  assert.deepEqual(fieldOf({ seed: 1.5 }), ['seed']);
  assert.deepEqual(fieldOf({ seed: 2147483648 }), ['seed']);
  assert.deepEqual(fieldOf({ seed: '7' }), ['seed']);
});

test('检查镜头组参数：模型不支持种子、指定时长小于镜头总时长或不在模型取值内时给出阻断问题', () => {
  const withParams = (overrides: Partial<GenerationParams>): GenerationParams => ({ ...PARAMS, ...overrides });
  assert.deepEqual(validateGroupParams(FAKE_VIDEO_CAPABILITY, withParams({ seed: 7, durationSeconds: 8 }), 6), []);
  assert.deepEqual(validateGroupParams(FAKE_VIDEO_CAPABILITY, withParams({}), 6), []);
  const noSeed = { ...FAKE_VIDEO_CAPABILITY, seed: false };
  assert.match(validateGroupParams(noSeed, withParams({ seed: 7 }), 6).join(), /不支持随机种子/);
  assert.match(validateGroupParams(FAKE_VIDEO_CAPABILITY, withParams({ durationSeconds: 5 }), 6).join(), /小于这一组镜头的总时长 6 秒/);
  assert.match(validateGroupParams(FAKE_VIDEO_CAPABILITY, withParams({ durationSeconds: 11 }), 6).join(), /不在模型支持的取值内（2–10 秒/);
  assert.match(validateGroupParams(FAKE_VIDEO_CAPABILITY, withParams({ durationSeconds: 7.5 }), 6).join(), /不在模型支持的取值内/);
});

test('读取提交请求：标识、镜头组数量、声音模式不合法时报错', () => {
  const base = { workId: 1, episodeId: 2, groupIds: [5], params: { modelId: 3 } };
  const rejected = (input: unknown) => assert.throws(() => readSubmitInput(input), ValidationError);
  rejected(null);
  rejected({ ...base, workId: 'x' });
  rejected({ ...base, episodeId: 1.5 });
  rejected({ ...base, groupIds: [] });
  rejected({ ...base, groupIds: ['a'] });
  rejected({ ...base, groupIds: Array.from({ length: 101 }, (_, index) => index) });
  rejected({ ...base, params: {} });
  rejected({ ...base, params: { modelId: 3, audioMode: 'invalid' } });
  rejected({ ...base, params: { modelId: 3, resolution: 'x'.repeat(21) } });
});

test('组时长对齐：只向上取整（不截断镜头），不足最短时长时补到最短，超过最长时长时标记并返回最长值', () => {
  assert.deepEqual(fitGroupDuration({ min: 2, max: 10, step: 1 }, 3.4), { seconds: 4, adjusted: true, exceedsMax: false });
  assert.deepEqual(fitGroupDuration({ min: 2, max: 10, step: 1 }, 4), { seconds: 4, adjusted: false, exceedsMax: false });
  assert.deepEqual(fitGroupDuration({ min: 2, max: 10, step: 1 }, 1), { seconds: 2, adjusted: true, exceedsMax: false });
  assert.deepEqual(fitGroupDuration({ min: 2, max: 10, step: 1 }, 40), { seconds: 10, adjusted: true, exceedsMax: true });
  assert.deepEqual(fitGroupDuration({ options: [10, 5] }, 7.4), { seconds: 10, adjusted: true, exceedsMax: false });
  assert.deepEqual(fitGroupDuration({ options: [5, 10] }, 12), { seconds: 10, adjusted: true, exceedsMax: true });
  assert.deepEqual(fitGroupDuration({ max: 8 }, 8.2), { seconds: 8, adjusted: true, exceedsMax: true });
  assert.deepEqual(fitGroupDuration({ min: 2, max: 30, step: 1 }, 14.1 + 0.9), { seconds: 15, adjusted: false, exceedsMax: false }, '小数误差不会多加一秒');
});

test('模型单次最长时长：取可选值的最大值或范围上限，没有信息时为 null', () => {
  assert.equal(maxGroupSeconds({ min: 2, max: 30, step: 1 }), 30);
  assert.equal(maxGroupSeconds({ options: [5, 15, 10] }), 15);
  assert.equal(maxGroupSeconds({ min: 2 }), null);
});

test('时间标注：分:秒，小数秒保留 1 位', () => {
  assert.deepEqual([0, 5, 59, 75, 600].map(formatTimestamp), ['0:00', '0:05', '0:59', '1:15', '10:00']);
  assert.equal(formatTimestamp(2.5), '0:02.5');
});

test('编译镜头组：多个镜头用时间段依次描述，总时长为各镜头之和，快照记录组内镜头', () => {
  const snapshot = planMany([
    shot({ id: 10, durationSeconds: 3, promptZh: '远景，灯塔在暴风雨中' }),
    shot({ id: 11, seq: 2, durationSeconds: 3, promptZh: '中景，守夜人点燃油灯' }),
    shot({ id: 12, seq: 3, durationSeconds: 3, promptZh: '特写，灯光扫过海面' })
  ]);
  assert.equal(
    snapshot.prompt,
    ['多镜头分镜，共 3 个镜头，按时间段依次呈现，镜头之间自然切换：', '(0:00 - 0:03) 远景，灯塔在暴风雨中', '(0:03 - 0:06) 中景，守夜人点燃油灯', '(0:06 - 0:09) 特写，灯光扫过海面'].join('\n')
  );
  assert.deepEqual(snapshot.shotIds, [10, 11, 12]);
  assert.equal(snapshot.params.durationSeconds, 9);
});

test('编译镜头组：总时长对齐后最后一段补足；单个镜头不加时间段和分镜说明', () => {
  const snapshot = planMany([shot({ id: 10, durationSeconds: 4.2 }), shot({ id: 11, seq: 2, durationSeconds: 3.1, promptZh: '第二个镜头' })]);
  assert.equal(snapshot.params.durationSeconds, 8);
  assert.ok(snapshot.prompt.endsWith('(0:04.2 - 0:08) 第二个镜头'));
  assert.match(snapshot.warnings.join(), /共 7.3 秒.*已调整为 8 秒/);
  assert.ok(!plan({}).prompt.includes('(0:00'));
  assert.ok(!plan({}).prompt.includes('多镜头'));
});

test('编译镜头组：组内不同镜头的声音挂在各自的时间段里；参考图按组内实体统一编号，只列一次', () => {
  const snapshot = planMany(
    [
      shot({ id: 10, durationSeconds: 5, promptZh: '镜头一', sounds: [sound({ kind: 'dialogue', speakerEntityId: 1, text: '要下雨了' })] }),
      shot({ id: 11, seq: 2, durationSeconds: 5, promptZh: '镜头二', sounds: [sound({ id: 2, kind: 'sfx', text: '雷声' })] })
    ],
    [GUARD]
  );
  assert.equal(
    snapshot.prompt,
    [
      '图1是角色“守夜人”的形象参考。',
      '多镜头分镜，共 2 个镜头，按时间段依次呈现，镜头之间自然切换：',
      '(0:00 - 0:05) 镜头一 声音：守夜人说：“要下雨了”',
      '(0:05 - 0:10) 镜头二 声音：音效：雷声'
    ].join('\n')
  );
  assert.deepEqual(snapshot.referenceImageFileIds, [101]);
});

test('编译镜头组：只有组内第一个镜头的首帧设置会处理，组内其他镜头的尾帧衔接在同一个视频里自然完成', () => {
  const inner = planMany([shot({ id: 10 }), shot({ id: 11, seq: 2, firstFrameMode: 'prev_tail' })]);
  assert.deepEqual(inner.warnings, []);
  const leading = planMany([shot({ id: 10, firstFrameMode: 'prev_tail' }), shot({ id: 11, seq: 2 })]);
  assert.match(leading.warnings.join(), /没有上一组可用/);
});

test('编译镜头组：用上一组尾帧作首帧时不传参考图和音色参考，提示词里不再有参考编号', () => {
  const speaker: EntityReferences = { ...GUARD, voiceFileId: 201 };
  const dialogue = shot({ firstFrameMode: 'prev_tail', sounds: [sound({ speakerEntityId: 1, text: '要下雨了' })] });
  const normal = planMany([dialogue], [speaker], { ...FAKE_VIDEO_CAPABILITY, audioInputMax: { count: 1, maxSeconds: 10 } });
  assert.deepEqual([normal.referenceImageFileIds, normal.referenceAudioFileIds], [[101], [201]]);

  const continued = planGroupRequest({
    shots: [dialogue],
    storyboardRunId: 3,
    providerCode: 'fake',
    modelCode: 'fake-video',
    capability: { ...FAKE_VIDEO_CAPABILITY, audioInputMax: { count: 1, maxSeconds: 10 } },
    params: PARAMS,
    entities: [speaker],
    useFirstFrame: true
  });
  assert.deepEqual([continued.referenceImageFileIds, continued.referenceAudioFileIds], [[], []]);
  assert.ok(!continued.prompt.includes('图1') && !continued.prompt.includes('音频1'));
  assert.ok(continued.prompt.includes('守夜人说：“要下雨了”'), '声音提示词仍然保留');
  assert.match(continued.warnings.join(), /尾帧作首帧.*不传参考素材/);
  assert.ok(!continued.warnings.join().includes('没有上一组可用'));
});

test('读取尾帧上传：类型、宽高、内容大小不合法时报错', () => {
  const base = { resultId: 4, mimeType: 'image/jpeg', width: 640, height: 360, data: 'AAAA' };
  assert.deepEqual(readTailFrameInput(base), { resultId: 4, mimeType: 'image/jpeg', width: 640, height: 360, dataBase64: 'AAAA' });
  const rejected = (input: unknown) => assert.throws(() => readTailFrameInput(input), ValidationError);
  rejected(null);
  rejected({ ...base, resultId: 'x' });
  rejected({ ...base, mimeType: 'image/gif' });
  rejected({ ...base, width: 0 });
  rejected({ ...base, height: 1.5 });
  rejected({ ...base, width: 20000 });
  rejected({ ...base, data: '' });
  rejected({ ...base, data: 5 });
  rejected({ ...base, data: 'A'.repeat(14 * 1024 * 1024) });
});

test('读取尾帧失败上报：原因去掉首尾空格并截断，缺省为空串', () => {
  assert.deepEqual(readTailFrameFailure({ resultId: 2, reason: '  无法解码  ' }), { resultId: 2, reason: '无法解码' });
  assert.equal(readTailFrameFailure({ resultId: 2 }).reason, '');
  assert.equal(readTailFrameFailure({ resultId: 2, reason: 'x'.repeat(500) }).reason.length, 200);
  assert.throws(() => readTailFrameFailure({ reason: 'x' }), ValidationError);
});

test('失败说明：本扩展自己产生的错误码有专门的说明，其他错误码按分类', () => {
  const unavailable = describeJobFailure({ category: 'invalid_request', code: PREVIOUS_GROUP_UNAVAILABLE_CODE, message: 'x' });
  assert.match(unavailable.label, /上一组/);
  assert.match(describeJobFailure({ category: 'invalid_request', code: TAIL_FRAME_UNAVAILABLE_CODE, message: 'x' }).label, /尾帧/);
  assert.equal(describeJobFailure({ category: 'server', code: 'constructor', message: 'x' }).label, '服务端错误');
});

test('编译镜头：使用中文提示词、对齐时长，默认原生声音并记录快照', () => {
  const snapshot = plan({ durationSeconds: 3.6 });
  assert.equal(snapshot.prompt, '中景，守夜人缓缓登上灯塔');
  assert.deepEqual(snapshot.params, {
    aspectRatio: '16:9',
    resolution: '720P',
    durationSeconds: 4,
    audioMode: 'native',
    audioElements: ['dialogue', 'sfx'],
    seed: null,
    extraParams: {}
  });
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
  assert.ok(snapshot.warnings.includes('模型不支持以下声音内容，已忽略：旁白、配乐。'));
});

test('编译镜头：声音内容只传选中的类型；选了模型不支持的内容才提醒，没选的类型不提醒；没选对白时不带音色参考', () => {
  const sounds = [
    sound({ id: 1, kind: 'dialogue', speakerEntityId: 1, text: '要下雨了' }),
    sound({ id: 2, kind: 'narration', text: '夜深了' }),
    sound({ id: 3, kind: 'sfx', text: '海浪声' })
  ];
  const onlySfx = plan({ sounds }, [GUARD], FAKE_VIDEO_CAPABILITY, { ...PARAMS, audioElements: ['sfx'] });
  assert.ok(onlySfx.prompt.endsWith('声音：音效：海浪声'));
  assert.ok(!onlySfx.prompt.includes('要下雨了'));
  assert.deepEqual(onlySfx.params.audioElements, ['sfx']);
  assert.deepEqual(onlySfx.warnings.filter((warning) => warning.includes('声音内容')), []);

  const withNarration = plan({ sounds }, [GUARD], FAKE_VIDEO_CAPABILITY, { ...PARAMS, audioElements: ['narration', 'sfx'] });
  assert.ok(withNarration.warnings.includes('模型不支持以下声音内容，已忽略：旁白。'));
  assert.deepEqual(withNarration.params.audioElements, ['sfx']);

  const voiced: EntityReferences = { ...GUARD, voiceFileId: 201 };
  const withVoiceModel = { ...FAKE_VIDEO_CAPABILITY, voiceReference: true, audioInputMax: { count: 2, maxSeconds: 15 } };
  assert.deepEqual(plan({ sounds }, [voiced], withVoiceModel, { ...PARAMS, audioElements: ['sfx'] }).referenceAudioFileIds, []);
  assert.deepEqual(plan({ sounds }, [voiced], withVoiceModel, { ...PARAMS, audioElements: ['dialogue'] }).referenceAudioFileIds, [201]);
});

test('编译镜头：种子写入快照；本组指定生成时长时直接采用，不再向上对齐', () => {
  const seeded = plan({ durationSeconds: 3.6 }, [], FAKE_VIDEO_CAPABILITY, { ...PARAMS, seed: 42, durationSeconds: 8 });
  assert.equal(seeded.params.seed, 42);
  assert.equal(seeded.params.durationSeconds, 8);
  assert.ok(!seeded.warnings.some((warning) => warning.includes('已调整为')));
  assert.equal(plan({ durationSeconds: 3.6 }).params.durationSeconds, 4, '没有指定时按镜头总时长对齐');
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

test('编译镜头：没有上一组可用的尾帧衔接、指定图片已不可用时给出提醒但不阻断', () => {
  assert.match(plan({ firstFrameMode: 'prev_tail' }).warnings.join(), /上一镜头尾帧作首帧.*没有上一组可用/);
  assert.match(plan({ firstFrameMode: 'asset' }).warnings.join(), /指定图片作首帧.*已不可用/);
  assert.deepEqual(plan({ firstFrameMode: 'none' }).warnings, []);
});

test('编译镜头组：指定图片作首帧时记下首帧文件，不传参考图和音色参考，快照里没有这个键则表示未指定', () => {
  const speaker: EntityReferences = { ...GUARD, voiceFileId: 201 };
  const dialogue = shot({ firstFrameMode: 'asset', firstFrameAssetId: 7, sounds: [sound({ speakerEntityId: 1, text: '要下雨了' })] });
  const capability = { ...FAKE_VIDEO_CAPABILITY, audioInputMax: { count: 1, maxSeconds: 10 } };
  const withImage = planGroupRequest({
    shots: [dialogue],
    storyboardRunId: 3,
    providerCode: 'fake',
    modelCode: 'fake-video',
    capability,
    params: PARAMS,
    entities: [speaker],
    firstFrameFileId: 301
  });
  assert.equal(withImage.firstFrameFileId, 301);
  assert.deepEqual([withImage.referenceImageFileIds, withImage.referenceAudioFileIds], [[], []]);
  assert.ok(!withImage.prompt.includes('图1') && !withImage.prompt.includes('音频1'));
  assert.match(withImage.warnings.join(), /指定的图片作首帧.*不传参考素材/);
  assert.ok(!withImage.warnings.join().includes('已不可用'));

  assert.ok(!('firstFrameFileId' in planMany([shot()])), '没有指定首帧图片时快照不带这个键');
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
