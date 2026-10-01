// ------------------------------------------------------------------------
// 名称：work-list-handlers.test.ts
// 说明：作品列表页请求处理的自动化测试：按素材来源读取全部项目的作品、待处理请求、创意产出请求的作品校验、名称确认删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：使用内存数据库、真实的服务与脚本化的假文本生成端口，通过消息路由器发送请求。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { MessageRouter } from '../messaging/message-router';
import { createServiceFixture } from '../services/testing/service-fixture';
import { STAGE_REQUESTS } from './stage-handlers';
import { WORK_LIST_REQUESTS, WorkListRequest, WorkListRow, registerWorkListHandlers } from './work-list-handlers';

const PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具：两个项目各有文字灵感作品，另有一个小说改编作品；页面绑定文字灵感。 */
function createFixture() {
  const fixture = createServiceFixture();
  const { projects, works } = fixture;
  const other = projects.createProject({ name: '项目乙' });
  const first = works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const second = works.createWork(other.id, normalizeWorkCreation({ workName: '作品乙', kind: '单个短视频' }, 'text'));
  const novel = works.createWork(
    fixture.project.id,
    normalizeWorkCreation({ workName: '小说作品', kind: '单个短视频', novelFile: JSON.stringify([{ name: 'a.txt', data: Buffer.from('正文').toString('base64') }]) }, 'novel')
  );

  const state: { pending: WorkListRequest | undefined } = { pending: undefined };
  const router = new MessageRouter();
  registerWorkListHandlers(router, 'text', fixture, {
    takePending: () => {
      const taken = state.pending;
      state.pending = undefined;
      return taken;
    }
  });
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { ...fixture, first, second, novel, state, send };
}

test('读取：返回绑定素材来源下全部项目的作品（含所属项目名与创意状态）和项目清单', async () => {
  const { database, send, first, stages, runner } = createFixture();
  try {
    await stages.startCreative(first.id, PARAMS);
    await runner.whenIdle();
    const response = await send(WORK_LIST_REQUESTS.load);
    assert.ok(response?.ok);
    const data = response.data as { sourceType: string; projects: Array<{ name: string }>; works: WorkListRow[] };
    assert.equal(data.sourceType, 'text');
    assert.deepEqual(data.projects.map((project) => project.name).sort(), ['项目乙', '项目甲']);
    assert.deepEqual(
      data.works.map((work) => [work.name, work.projectName, work.creative.display]).sort(),
      [
        ['作品乙', '项目乙', 'none'],
        ['作品甲', '项目甲', 'pending']
      ].sort()
    );
  } finally {
    database.close();
  }
});

test('待处理请求：取走后不再返回', async () => {
  const { database, send, state } = createFixture();
  try {
    state.pending = { action: 'create' };
    const first = await send(WORK_LIST_REQUESTS.takePending);
    assert.deepEqual(first?.ok && first.data, { request: { action: 'create' } });
    const second = await send(WORK_LIST_REQUESTS.takePending);
    assert.deepEqual(second?.ok && second.data, { request: undefined });
  } finally {
    database.close();
  }
});

test('创意产出请求：作品不存在或缺少作品标识时返回错误，版本必须属于请求指定的作品', async () => {
  const { database, send, first, second, stages, runner } = createFixture();
  try {
    await stages.startCreative(first.id, PARAMS);
    await runner.whenIdle();

    const ok = await send(STAGE_REQUESTS.load, { workId: first.id, stage: 'creative' });
    assert.ok(ok?.ok);
    assert.equal((ok.data as { work: { id: number } }).work.id, first.id);

    const missing = await send(STAGE_REQUESTS.load, { workId: 999, stage: 'creative' });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const absent = await send(STAGE_REQUESTS.load, { stage: 'creative' });
    assert.ok(absent && !absent.ok && absent.error.kind === 'validation');

    const run = stages.getCreativeView(first.id).run;
    const forged = await send(STAGE_REQUESTS.approve, { workId: second.id, stage: 'creative', id: run.id });
    assert.ok(forged && !forged.ok, '用其他作品的标识不能操作这个作品的版本');
    assert.equal(stages.getCreativeView(first.id).run.display, 'pending');
  } finally {
    database.close();
  }
});

test('删除作品：宿主校验确认名称；删除会先取消正在进行的生成；作品不存在时返回错误', async () => {
  const { database, send, first, works, runs } = createFixture();
  try {
    const prepared = await send(WORK_LIST_REQUESTS.prepareDelete, { id: first.id });
    assert.deepEqual(prepared?.ok && prepared.data, { name: '作品甲' });

    const wrong = await send(WORK_LIST_REQUESTS.delete, { id: first.id, confirmName: '别的' });
    assert.ok(wrong && !wrong.ok && wrong.error.fieldErrors?.confirmName);
    assert.equal(works.getWork(first.id).name, '作品甲');

    const right = await send(WORK_LIST_REQUESTS.delete, { id: first.id, confirmName: '作品甲' });
    assert.deepEqual(right?.ok && right.data, { deleted: true, name: '作品甲' });
    assert.equal(works.findWork(first.id), undefined);
    assert.equal(runs.findRunning({ workId: first.id, stage: 'creative', episodeId: null }), undefined);

    const again = await send(WORK_LIST_REQUESTS.delete, { id: first.id, confirmName: '作品甲' });
    assert.ok(again && !again.ok && again.error.kind === 'not-found');
  } finally {
    database.close();
  }
});
