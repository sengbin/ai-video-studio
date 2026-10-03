// ------------------------------------------------------------------------
// 名称：service-fixture.ts
// 说明：服务层与页面处理测试共用的夹具：内存数据库、真实的服务与执行器、脚本化的假文本生成端口和一个项目。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../../infra/database/sqlite-asset-repository';
import { SqliteProjectRepository } from '../../../infra/database/sqlite-project-repository';
import { SqliteScreenplayRepository } from '../../../infra/database/sqlite-screenplay-repository';
import { SqliteChapterRepository, SqliteStageRunRepository } from '../../../infra/database/sqlite-stage-run-repository';
import { SqliteStoryboardRepository } from '../../../infra/database/sqlite-storyboard-repository';
import { SqliteWorkRepository } from '../../../infra/database/sqlite-work-repository';
import { SqliteWorkSourceReader } from '../../../infra/database/sqlite-work-source-reader';
import { CreativeWorkflow } from '../../stages/creative-workflow';
import { ScreenplayWorkflow } from '../../stages/screenplay-workflow';
import { StageRunner } from '../../stages/stage-runner';
import { StoryboardWorkflow } from '../../stages/storyboard-workflow';
import { FILE_PROMPTS, Responder, ScriptedText, standardResponder } from '../../stages/testing/scripted-text';
import { ChangeNotifier } from '../change-notifier';
import { ProjectService } from '../project-service';
import { ScreenplayService } from '../screenplay-service';
import { StageChange, StageService } from '../stage-service';
import { StoryboardService } from '../storyboard-service';
import { WorkService } from '../work-service';
import { MemoryAssetFileStore } from '../../../domain/ports/testing/memory-asset-file-store';

/** 服务层夹具。 */
export interface ServiceFixture {
  readonly database: DatabaseSync;
  readonly runs: SqliteStageRunRepository;
  readonly projects: ProjectService;
  readonly works: WorkService;
  readonly stages: StageService;
  readonly screenplays: ScreenplayService;
  readonly storyboards: StoryboardService;
  readonly runner: StageRunner;
  readonly text: ScriptedText;
  /** 阶段变化通知器，执行器与服务共用。 */
  readonly changes: ChangeNotifier<StageChange>;
  /** 收到的全部阶段变化通知。 */
  readonly changed: StageChange[];
  /** 已创建的项目。 */
  readonly project: { readonly id: number; readonly name: string };
}

/**
 * 创建服务层夹具。
 * @param responder 假文本生成端口的响应函数，默认按提示词返回合规内容。
 * @param sceneBatchMaxChars 分镜脚本按场次分批的单批字数上限，缺省用正式值。
 */
export function createServiceFixture(responder: Responder = standardResponder, sceneBatchMaxChars?: number): ServiceFixture {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const runs = new SqliteStageRunRepository(database);
  const chapters = new SqliteChapterRepository(database);
  const screenplayRepository = new SqliteScreenplayRepository(database);
  const storyboardRepository = new SqliteStoryboardRepository(database);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const works = new WorkService(new SqliteWorkRepository(database), runs);
  const text = new ScriptedText(responder);
  const changes = new ChangeNotifier<StageChange>();
  const changed: StageChange[] = [];
  changes.subscribe((change) => changed.push(change));
  const runner = new StageRunner({
    runs,
    texts: text,
    workflows: [
      new CreativeWorkflow({
        chapters,
        sources: new SqliteWorkSourceReader(database),
        prompts: FILE_PROMPTS,
        getSplitSettings: () => ({ mode: 'chapter', maxSegmentChars: 1000 })
      }),
      new ScreenplayWorkflow({ chapters, screenplays: screenplayRepository, prompts: FILE_PROMPTS }),
      new StoryboardWorkflow({ screenplays: screenplayRepository, storyboards: storyboardRepository, prompts: FILE_PROMPTS, sceneBatchMaxChars })
    ],
    notify: (run) => changes.notify({ workId: run.workId, runId: run.id, stage: run.stage })
  });
  const stages = new StageService({ works, runs, chapters, screenplays: screenplayRepository, runner, changes });
  const screenplays = new ScreenplayService({ works, runs, screenplays: screenplayRepository, runner, stages });
  const storyboards = new StoryboardService({
    works,
    projects,
    runs,
    screenplays: screenplayRepository,
    storyboards: storyboardRepository,
    assets: new SqliteAssetRepository(database, new MemoryAssetFileStore()),
    runner,
    stages
  });
  const project = projects.createProject({ name: '项目甲' });
  return { database, runs, projects, works, stages, screenplays, storyboards, runner, text, changes, changed, project };
}
