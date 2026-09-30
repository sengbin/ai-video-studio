// ------------------------------------------------------------------------
// 名称：stage-runner-sqlite.test.ts
// 说明：阶段执行器、创意工作流与 SQLite 仓库联合运行的自动化测试：真实落库、进度经 JSON 往返后继续、素材读取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库与脚本化的假文本生成端口，提示词读取 resources/prompts 下的真实模板。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { StageTarget } from '../../domain/models/stage-run';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteChapterRepository, SqliteStageRunRepository } from '../../infra/database/sqlite-stage-run-repository';
import { SqliteWorkSourceReader } from '../../infra/database/sqlite-work-source-reader';
import { CreativeWorkflow } from './creative-workflow';
import { StageRunner } from './stage-runner';
import { FILE_PROMPTS, ScriptedText, standardResponder } from './testing/scripted-text';

const NOW = '2026-01-01T00:00:00.000Z';
const TARGET: StageTarget = { workId: 1, stage: 'creative', episodeId: null };
const NOVEL_INPUT = {
  sourceType: 'novel',
  params: { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 }
};
const NOVEL_TEXT = ['第一章 起', '甲'.repeat(600), '第二章 承', '乙'.repeat(600), '第三章 合', '丙'.repeat(600)].join('\n');

/** 创建库并写入项目、作品和小说原文素材。 */
function createDatabaseWithNovel(): DatabaseSync {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run('项目甲', NOW, NOW);
  database
    .prepare('INSERT INTO works (project_id, name, kind, source_type, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run('作品甲', 'single', 'novel', NOW, NOW);
  const content = Buffer.from(NOVEL_TEXT, 'utf8');
  database
    .prepare(
      "INSERT INTO work_sources (work_id, kind, file_name, mime, size_bytes, content, sort_order, created_at) VALUES (1, 'novel_text', 'novel.txt', 'text/plain', ?, ?, 0, ?)"
    )
    .run(content.length, content, NOW);
  return database;
}

test('联合运行：小说改编写入章节与阶段记录，进度保存为合法 JSON', async () => {
  const database = createDatabaseWithNovel();
  try {
    const runs = new SqliteStageRunRepository(database);
    const text = new ScriptedText(standardResponder);
    const workflow = new CreativeWorkflow({
      chapters: new SqliteChapterRepository(database),
      sources: new SqliteWorkSourceReader(database),
      prompts: FILE_PROMPTS,
      getSplitSettings: () => ({ mode: 'chapter', maxSegmentChars: 1000 })
    });
    const runner = new StageRunner({ runs, text, workflows: [workflow] });

    const started = await runner.start({ target: TARGET, input: NOVEL_INPUT });
    await runner.whenIdle();

    const run = runs.findById(started.id)!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.reviewStatus, 'pending');
    assert.equal(run.modelInfo, 'copilot/test');
    assert.equal(run.progress?.done, run.progress?.total);
    const chapters = database.prepare('SELECT seq, title FROM chapters WHERE run_id = ? ORDER BY seq').all(started.id);
    assert.deepEqual(
      chapters.map((row) => row.title),
      ['第1章', '第2章', '第3章']
    );
    const stored = database.prepare('SELECT progress_json AS progress FROM stage_runs WHERE id = ?').get(started.id) as {
      progress: string;
    };
    assert.doesNotThrow(() => JSON.parse(stored.progress));
    assert.equal(text.requests.length, 7);
  } finally {
    database.close();
  }
});

test('联合运行：失败后继续时，要点与大纲从数据库中的进度还原，已保存的章节不重复生成', async () => {
  const database = createDatabaseWithNovel();
  try {
    const runs = new SqliteStageRunRepository(database);
    let broken = true;
    const text = new ScriptedText((request) =>
      broken && request.user.includes('# 任务：撰写第 3 章') ? { title: '缺少正文' } : standardResponder(request)
    );
    const workflow = new CreativeWorkflow({
      chapters: new SqliteChapterRepository(database),
      sources: new SqliteWorkSourceReader(database),
      prompts: FILE_PROMPTS,
      getSplitSettings: () => ({ mode: 'chapter', maxSegmentChars: 1000 })
    });
    const runner = new StageRunner({ runs, text, workflows: [workflow] });

    const started = await runner.start({ target: TARGET, input: NOVEL_INPUT });
    await runner.whenIdle();
    assert.equal(runs.findById(started.id)?.status, 'failed');
    const before = text.requests.length;

    broken = false;
    await runner.resume(started.id);
    await runner.whenIdle();

    assert.equal(runs.findById(started.id)?.status, 'succeeded');
    assert.equal(text.requests.length - before, 1, '只补生成第 3 章');
    assert.match(text.requests.at(-1)!.user, /撰写第 3 章/);
    assert.equal(runs.listVersions(TARGET).length, 1);
  } finally {
    database.close();
  }
});
