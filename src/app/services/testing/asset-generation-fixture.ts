// ------------------------------------------------------------------------
// 名称：asset-generation-fixture.ts
// 说明：资产生成相关测试的共用夹具：内存数据库、真实的服务与仓库、假图像与音频适配器、假下载器和可调时钟；队列由测试显式驱动。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：仅供自动化测试使用，随 out/**/testing 一起被打包排除；服务的调度器不自动处理，测试调用 queue.pump() 驱动，避免与后台处理竞争。
// ------------------------------------------------------------------------

import { ProviderRegistry } from '../../../domain/ports/provider-registry';
import {
  FAKE_ASSET_IMAGE_CAPABILITY,
  FAKE_PROVIDER_CODE,
  FakeAudioProvider,
  FakeImageProvider
} from '../../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../../domain/ports/testing/memory-secret-store';
import { providerApiKeySecretKey } from '../../../domain/rules/provider-rules';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../../infra/database/sqlite-asset-repository';
import { SqliteAssetVersionRepository } from '../../../infra/database/sqlite-asset-version-repository';
import { SqliteProjectRepository } from '../../../infra/database/sqlite-project-repository';
import { SqliteProviderRepository } from '../../../infra/database/sqlite-provider-repository';
import { AssetGenerationQueue, AssetGenerationQueueDependencies, AssetVersionChange } from '../../queue/asset-generation-queue';
import { AssetGenerationService } from '../asset-generation-service';
import { AssetService } from '../asset-service';
import { ProjectService } from '../project-service';
import { ProviderService } from '../provider-service';

/** 最小的有效 PNG 文件头（含几个多余字节）。 */
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** 最小的有效 WAV 文件头。 */
export const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);

/** 图像结果的下载地址。 */
export const IMAGE_URL = 'https://fake.example.com/image.png';
/** 音频结果的下载地址。 */
export const AUDIO_URL = 'https://fake.example.com/audio.wav';

/** 创建夹具；provider 参数控制是否配置了访问密钥。 */
export async function createAssetGenerationFixture(
  options: { withApiKey?: boolean; queue?: Partial<AssetGenerationQueueDependencies> } = {}
) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assetRepository = new SqliteAssetRepository(database);
  const versions = new SqliteAssetVersionRepository(database);
  const assets = new AssetService(assetRepository, projects);
  const image = new FakeImageProvider([
    { code: 'fake-image', displayName: '假图像模型', kind: 'image', capability: FAKE_ASSET_IMAGE_CAPABILITY }
  ]);
  const audio = new FakeAudioProvider();
  const secrets = new MemorySecretStore();
  const providerService = new ProviderService({
    repository: new SqliteProviderRepository(database),
    registry: new ProviderRegistry().register(image).register(audio),
    secrets
  });
  providerService.syncCatalog();
  if (options.withApiKey !== false) {
    await secrets.set(providerApiKeySecretKey(FAKE_PROVIDER_CODE), 'sk-fake');
  }

  /** 下载地址到内容；没有登记的地址下载失败。 */
  const downloads = new Map<string, Buffer>([
    [IMAGE_URL, PNG_BYTES],
    [AUDIO_URL, WAV_BYTES]
  ]);
  const downloader = {
    download: async (url: string): Promise<Buffer> => {
      const content = downloads.get(url);
      if (content === undefined) {
        throw new Error('下载失败（HTTP 404）。');
      }
      return content;
    }
  };
  const clock = { time: Date.parse('2026-10-02T08:00:00.000Z') };
  const changes: AssetVersionChange[] = [];
  const notifications: number[] = [];
  const queue = new AssetGenerationQueue({
    versions,
    assets: assetRepository,
    calls: providerService,
    downloader,
    notify: (change) => changes.push(change),
    now: () => new Date(clock.time),
    submitRetryDelayMs: 1000,
    ...options.queue
  });
  const generation = new AssetGenerationService({
    assets: assetRepository,
    versions,
    providers: providerService,
    scheduler: { pump: async () => undefined, cancel: (versionId) => queue.cancel(versionId) },
    notify: () => notifications.push(1),
    now: () => new Date(clock.time)
  });
  const project = projects.createProject({ name: '项目甲' });
  return { database, projects, project, assets, assetRepository, versions, providerService, image, audio, downloads, clock, changes, notifications, queue, generation };
}
