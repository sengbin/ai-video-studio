// ------------------------------------------------------------------------
// 名称：workbench-handlers.test.ts
// 说明：生成工作台请求处理的自动化测试：各请求转发到生成服务、打开结果视频走宿主注入的 openFile、标识不合法时报错、阶段产出请求已注册。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：通过真实的消息路由器调用；生成服务用记录调用的替身，业务行为见 generation-service.test.ts。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageRouter } from '../messaging/message-router';
import { BindingService } from '../services/binding-service';
import { GenerationProfileService } from '../services/generation-profile-service';
import { GenerationService, SubmitResult } from '../services/generation-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { StoryboardService } from '../services/storyboard-service';
import { WorkService } from '../services/work-service';
import { STAGE_REQUESTS } from './stage-handlers';
import { BINDING_REQUESTS } from './binding-handlers';
import { WORKBENCH_REQUESTS, describeSubmitResult, registerWorkbenchHandlers } from './workbench-handlers';

/** 创建路由器与记录调用的替身。 */
function createFixture() {
  const calls: Array<[string, unknown]> = [];
  const opened: string[] = [];
  const exported: Array<[string, string]> = [];
  const revealed: string[] = [];
  const notices: Array<[string, string]> = [];
  const read: string[] = [];
  const videoBytes = { current: new Uint8Array([1, 2, 3]) };
  const generation = {
    getCatalog: async () => ({ works: [], models: [] }),
    getEpisode: (workId: number, episodeId: number) => {
      calls.push(['episode', [workId, episodeId]]);
      return { workId, episodeId };
    },
    submit: async (payload: unknown) => {
      calls.push(['submit', payload]);
      return submitResult;
    },
    previewSubmit: async (payload: unknown) => {
      calls.push(['preview', payload]);
      return { groups: [] };
    },
    saveGroupProfile: (payload: unknown) => {
      calls.push(['saveGroupProfile', payload]);
      return { modelId: null, aspectRatio: null, resolution: '1080P', audioMode: null };
    },
    cancel: async (payload: unknown) => {
      calls.push(['cancel', payload]);
      return { remoteCanceled: false };
    },
    regroup: (payload: unknown) => void calls.push(['regroup', payload]),
    selectResult: (payload: unknown) => {
      calls.push(['selectResult', payload]);
      return { selected: true };
    },
    splitGroup: (payload: unknown) => void calls.push(['splitGroup', payload]),
    mergeGroup: (payload: unknown) => void calls.push(['mergeGroup', payload]),
    getResultPath: (payload: unknown) => {
      calls.push(['resultPath', payload]);
      return '/store/videos/1.mp4';
    },
    getResultFile: (payload: unknown) => {
      calls.push(['resultFile', payload]);
      return { path: '/store/videos/1.mp4', suggestedName: '作品-第1集-第1组-第1次.mp4' };
    },
    listPendingTailFrames: () => [{ resultId: 9 }],
    saveTailFrame: (payload: unknown) => {
      calls.push(['saveFrame', payload]);
      return { saved: true };
    },
    reportTailFrameFailure: (payload: unknown) => {
      calls.push(['frameFailed', payload]);
      return { failed: 1 };
    }
  } as unknown as GenerationService;
  const router = new MessageRouter();
  registerWorkbenchHandlers(
    router,
    {
      generation,
      profiles: {
        getView: (workId: number, episodeId: number) => {
          calls.push(['profile', [workId, episodeId]]);
          return { workId, episodeId };
        },
        save: (payload: unknown) => {
          calls.push(['saveProfile', payload]);
          return { saved: true };
        }
      } as unknown as GenerationProfileService,
      bindings: {
        getEpisodeView: (episodeId: number) => {
          calls.push(['bindingView', episodeId]);
          return { episodeId, entities: [] };
        }
      } as unknown as BindingService,
      works: { getWork: (id: number) => ({ id }) } as unknown as WorkService,
      stages: {} as StageService,
      screenplays: {} as ScreenplayService,
      storyboards: {} as StoryboardService
    },
    {
      openFile: async (absolutePath) => void opened.push(absolutePath),
      exportFile: async (absolutePath, suggestedName) => {
        exported.push([absolutePath, suggestedName]);
        return true;
      },
      revealFile: async (absolutePath) => void revealed.push(absolutePath),
      readFile: async (absolutePath) => {
        read.push(absolutePath);
        return videoBytes.current;
      },
      notify: (level, message) => void notices.push([level, message])
    }
  );
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  /** 发送请求并断言成功，返回响应数据。 */
  const callOk = async (name: string, payload?: unknown): Promise<unknown> => {
    const response = await send(name, payload);
    assert.ok(response?.ok, '请求应成功');
    return response.data;
  };
  return { calls, opened, exported, revealed, notices, read, videoBytes, send, callOk };
}

/** 提交结果替身：测试里直接修改它的内容。 */
const submitResult: SubmitResult = { submitted: [], rejected: [] };

test('清单、集视图、提交、提交预览、重新分组、拆分、合并、取消都转发给生成服务', async () => {
  const { calls, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.catalog), { works: [], models: [] });
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.episode, { workId: 1, episodeId: 2 }), { workId: 1, episodeId: 2 });

  const body = { workId: 1, episodeId: 2, groupIds: [3], params: { modelId: 4 } };
  await callOk(WORKBENCH_REQUESTS.submit, body);
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.preview, body), { groups: [] });
  const groupBody = { workId: 1, episodeId: 2, groupId: 3, changes: { resolution: '1080P' } };
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.saveGroupProfile, groupBody), { modelId: null, aspectRatio: null, resolution: '1080P', audioMode: null });
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.regroup, { workId: 1, episodeId: 2, maxSeconds: 20 }), { done: true });
  await callOk(WORKBENCH_REQUESTS.splitGroup, { workId: 1, episodeId: 2, shotId: 6 });
  await callOk(WORKBENCH_REQUESTS.mergeGroup, { workId: 1, episodeId: 2, groupId: 7 });
  await callOk(WORKBENCH_REQUESTS.cancel, { jobId: 5 });
  assert.deepEqual(calls, [
    ['episode', [1, 2]],
    ['submit', body],
    ['preview', body],
    ['saveGroupProfile', groupBody],
    ['regroup', { workId: 1, episodeId: 2, maxSeconds: 20 }],
    ['splitGroup', { workId: 1, episodeId: 2, shotId: 6 }],
    ['mergeGroup', { workId: 1, episodeId: 2, groupId: 7 }],
    ['cancel', { jobId: 5 }]
  ]);
});

test('读取集视图时作品或集标识不合法会报错', async () => {
  const { send } = createFixture();
  for (const payload of [{ workId: 'x', episodeId: 2 }, { workId: 1 }, undefined]) {
    const response = await send(WORKBENCH_REQUESTS.episode, payload);
    assert.ok(response !== undefined && !response.ok, JSON.stringify(payload));
  }
});

test('采用结果版本：转发给生成服务', async () => {
  const { calls, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.selectResult, { resultId: 9 }), { selected: true });
  assert.deepEqual(calls, [['selectResult', { resultId: 9 }]]);
});

test('打开结果视频：取得本机路径后交给宿主打开', async () => {
  const { calls, opened, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.openResult, { resultId: 9 }), { opened: true });
  assert.deepEqual(opened, ['/store/videos/1.mp4']);
  assert.deepEqual(calls, [['resultPath', { resultId: 9 }]]);
});

test('导出与在文件夹中显示：取得路径和建议文件名后交给宿主', async () => {
  const { calls, exported, revealed, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.exportResult, { resultId: 9 }), { exported: true });
  assert.deepEqual(exported, [['/store/videos/1.mp4', '作品-第1集-第1组-第1次.mp4']]);
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.revealResult, { resultId: 9 }), { revealed: true });
  assert.deepEqual(revealed, ['/store/videos/1.mp4']);
  assert.deepEqual(calls, [['resultFile', { resultId: 9 }], ['resultPath', { resultId: 9 }]]);
});

test('尾帧请求：列出待截取的结果、把结果视频以 Base64 交给页面、保存与上报失败转发给生成服务', async () => {
  const { calls, read, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.pendingFrames), [{ resultId: 9 }]);
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.resultVideo, { resultId: 9 }), { mimeType: 'video/mp4', data: 'AQID' });
  assert.deepEqual(read, ['/store/videos/1.mp4']);

  const frame = { resultId: 9, mimeType: 'image/jpeg', width: 640, height: 360, data: 'AAAA' };
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.saveFrame, frame), { saved: true });
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.frameFailed, { resultId: 9, reason: '无法解码视频' }), { failed: 1 });
  assert.deepEqual(calls, [['resultPath', { resultId: 9 }], ['saveFrame', frame], ['frameFailed', { resultId: 9, reason: '无法解码视频' }]]);
});

test('提交结果通过宿主通知：已提交为信息，有被拒绝的组为警告，没有内容时不通知', async () => {
  const { notices, callOk } = createFixture();
  await callOk(WORKBENCH_REQUESTS.submit, {});
  assert.deepEqual(notices, []);

  const mutable = submitResult as { submitted: SubmitResult['submitted']; rejected: SubmitResult['rejected'] };
  mutable.submitted = [{ groupId: 1, seq: 1, jobId: 5, warnings: ['尾帧衔接暂未支持'] }];
  await callOk(WORKBENCH_REQUESTS.submit, {});
  assert.deepEqual(notices, [['info', '已提交 1 个镜头组，生成需要几分钟，完成后会通知你。\n第 1 组：尾帧衔接暂未支持']]);

  mutable.rejected = [{ groupId: 2, seq: 2, issues: ['超过上限', '分辨率不支持'] }];
  await callOk(WORKBENCH_REQUESTS.submit, {});
  assert.equal(notices[1][0], 'warning');
  assert.match(notices[1][1], /第 2 组未提交：超过上限；分辨率不支持/);
  mutable.submitted = [];
  mutable.rejected = [];

  assert.equal(describeSubmitResult({ submitted: [], rejected: [] }), undefined);
});

test('绑定请求已注册：读取一集的绑定视图转发给绑定服务', async () => {
  const { calls, callOk } = createFixture();
  assert.deepEqual(await callOk(BINDING_REQUESTS.view, { episodeId: 3 }), { episodeId: 3, entities: [] });
  assert.deepEqual(calls, [['bindingView', 3]]);
});

test('生成参数请求：读取与保存转发给参数服务，读取时标识不合法会报错', async () => {
  const { calls, callOk, send } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.profile, { workId: 1, episodeId: 2 }), { workId: 1, episodeId: 2 });
  const body = { scope: 'work', workId: 1, episodeId: 2, changes: { resolution: '720P' } };
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.saveProfile, body), { saved: true });
  assert.deepEqual(calls, [['profile', [1, 2]], ['saveProfile', body]]);
  const response = await send(WORKBENCH_REQUESTS.profile, { workId: 'x', episodeId: 2 });
  assert.ok(response !== undefined && !response.ok);
});

test('阶段产出层的请求已注册：校验作品归属失败时返回错误而不是找不到处理函数', async () => {
  const { send } = createFixture();
  const response = await send(STAGE_REQUESTS.load, { workId: 'x', stage: 'storyboard_script', episodeId: 1 });
  assert.ok(response !== undefined && !response.ok);
  assert.notEqual(response.error.kind, 'unknown_request');
});
