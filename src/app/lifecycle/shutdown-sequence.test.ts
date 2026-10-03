// ------------------------------------------------------------------------
// 名称：shutdown-sequence.test.ts
// 说明：停用收尾序列的自动化测试：按登记顺序等待、殿后步骤最后执行、只执行一次、单个步骤失败不阻止后续步骤。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：失败会写控制台，测试中临时静默。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShutdownSequence } from './shutdown-sequence';

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('按登记顺序依次执行，异步步骤结束后才开始下一步', async () => {
  const log: string[] = [];
  const sequence = new ShutdownSequence();
  sequence.add(async () => {
    log.push('队列甲开始停止');
    await sleep(20);
    log.push('队列甲已停止');
  });
  sequence.add(() => {
    log.push('队列乙已停止');
  });
  await sequence.run();
  assert.deepEqual(log, ['队列甲开始停止', '队列甲已停止', '队列乙已停止']);
});

test('殿后步骤无论登记先后，都在全部普通步骤结束之后执行', async () => {
  const log: string[] = [];
  const sequence = new ShutdownSequence();
  sequence.addFinal(() => {
    log.push('关闭数据库');
  });
  sequence.add(async () => {
    await sleep(20);
    log.push('停止队列');
  });
  sequence.add(() => {
    log.push('等待阶段运行');
  });
  await sequence.run();
  assert.deepEqual(log, ['停止队列', '等待阶段运行', '关闭数据库']);
});

test('重复调用只执行一次，返回同一个结果', async () => {
  let count = 0;
  const sequence = new ShutdownSequence();
  sequence.add(async () => {
    await sleep(10);
    count += 1;
  });
  const first = sequence.run();
  const second = sequence.run();
  assert.equal(first, second);
  await Promise.all([first, second]);
  await sequence.run();
  assert.equal(count, 1);
});

test('某个步骤失败只记录日志，后续步骤（含殿后步骤）照常执行，序列不拒绝', async () => {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    const log: string[] = [];
    const sequence = new ShutdownSequence();
    sequence.add(() => {
      throw new Error('同步失败');
    });
    sequence.add(async () => {
      await sleep(5);
      throw new Error('异步失败');
    });
    sequence.add(() => {
      log.push('后续步骤');
    });
    sequence.addFinal(() => {
      log.push('关闭数据库');
    });
    await sequence.run();
    assert.deepEqual(log, ['后续步骤', '关闭数据库']);
    assert.equal(logged.length, 2);
  } finally {
    console.error = original;
  }
});

test('没有登记任何步骤时直接完成', async () => {
  await new ShutdownSequence().run();
});