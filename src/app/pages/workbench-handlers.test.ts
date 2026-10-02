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
import { GenerationService } from '../services/generation-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { StoryboardService } from '../services/storyboard-service';
import { WorkService } from '../services/work-service';
import { STAGE_REQUESTS } from './stage-handlers';
import { WORKBENCH_REQUESTS, registerWorkbenchHandlers } from './workbench-handlers';

/** 创建路由器与记录调用的替身。 */
function createFixture() {
  const calls: Array<[string, unknown]> = [];
  const opened: string[] = [];
  const generation = {
    getCatalog: async () => ({ works: [], models: [] }),
    getEpisode: (workId: number, episodeId: number) => {
      calls.push(['episode', [workId, episodeId]]);
      return { workId, episodeId };
    },
    submit: async (payload: unknown) => {
      calls.push(['submit', payload]);
      return { submitted: [], rejected: [] };
    },
    cancel: async (payload: unknown) => {
      calls.push(['cancel', payload]);
      return { remoteCanceled: false };
    },
    getResultPath: (payload: unknown) => {
      calls.push(['resultPath', payload]);
      return '/store/videos/1.mp4';
    }
  } as unknown as GenerationService;
  const router = new MessageRouter();
  registerWorkbenchHandlers(
    router,
    {
      generation,
      works: { getWork: (id: number) => ({ id }) } as unknown as WorkService,
      stages: {} as StageService,
      screenplays: {} as ScreenplayService,
      storyboards: {} as StoryboardService
    },
    { openFile: async (absolutePath) => void opened.push(absolutePath) }
  );
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  /** 发送请求并断言成功，返回响应数据。 */
  const callOk = async (name: string, payload?: unknown): Promise<unknown> => {
    const response = await send(name, payload);
    assert.ok(response?.ok, '请求应成功');
    return response.data;
  };
  return { calls, opened, send, callOk };
}

test('清单、集视图、提交、取消都转发给生成服务', async () => {
  const { calls, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.catalog), { works: [], models: [] });
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.episode, { workId: 1, episodeId: 2 }), { workId: 1, episodeId: 2 });

  const body = { workId: 1, episodeId: 2, shotIds: [3], params: { modelId: 4 } };
  await callOk(WORKBENCH_REQUESTS.submit, body);
  await callOk(WORKBENCH_REQUESTS.cancel, { jobId: 5 });
  assert.deepEqual(calls, [
    ['episode', [1, 2]],
    ['submit', body],
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

test('打开结果视频：取得本机路径后交给宿主打开', async () => {
  const { calls, opened, callOk } = createFixture();
  assert.deepEqual(await callOk(WORKBENCH_REQUESTS.openResult, { resultId: 9 }), { opened: true });
  assert.deepEqual(opened, ['/store/videos/1.mp4']);
  assert.deepEqual(calls, [['resultPath', { resultId: 9 }]]);
});

test('阶段产出层的请求已注册：校验作品归属失败时返回错误而不是找不到处理函数', async () => {
  const { send } = createFixture();
  const response = await send(STAGE_REQUESTS.load, { workId: 'x', stage: 'storyboard_script', episodeId: 1 });
  assert.ok(response !== undefined && !response.ok);
  assert.notEqual(response.error.kind, 'unknown_request');
});
