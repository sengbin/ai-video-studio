// ------------------------------------------------------------------------
// 名称：sqlite-work-text-model-repository.test.ts
// 说明：作品文本模型选择仓库的自动化测试：读取、保存、覆盖、清除，以及作品删除时随之清除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存数据库。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { SqliteWorkTextModelRepository } from './sqlite-work-text-model-repository';

const NOW = '2026-10-03T00:00:00.000Z';

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  database.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('项目', ?, ?)").run(NOW, NOW);
  const insertWork = database.prepare("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (1, ?, 'series', ?, ?)");
  insertWork.run('甲', NOW, NOW);
  insertWork.run('乙', NOW, NOW);
  return { database, repository: new SqliteWorkTextModelRepository(database, () => new Date(NOW)) };
}

test('读取、保存、覆盖与清除：没有选择为空，保存后可读，再次保存覆盖，清除后恢复为空', () => {
  const { database, repository } = createFixture();
  try {
    assert.equal(repository.find(1), null);
    repository.save(1, 'copilot:gpt-4o');
    repository.save(2, 'model:qianwen/qwen3.8-max');
    assert.deepEqual([repository.find(1), repository.find(2)], ['copilot:gpt-4o', 'model:qianwen/qwen3.8-max']);

    repository.save(1, 'copilot:');
    assert.equal(repository.find(1), 'copilot:');
    assert.equal(repository.find(2), 'model:qianwen/qwen3.8-max');

    repository.save(1, null);
    repository.save(1, null);
    assert.equal(repository.find(1), null);
  } finally {
    database.close();
  }
});

test('作品必须存在，作品删除时选择随之清除', () => {
  const { database, repository } = createFixture();
  try {
    assert.throws(() => repository.save(999, 'copilot:'));
    repository.save(1, 'copilot:');
    database.prepare('DELETE FROM works WHERE id = 1').run();
    assert.equal(repository.find(1), null);
  } finally {
    database.close();
  }
});