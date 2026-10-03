// ------------------------------------------------------------------------
// 名称：qianwen-prompt-compare.js
// 说明：视频提示词写法的对比实测脚本：同一组镜头、同一随机种子、同一组参数，分别用“早期写法（格式版本 1）”和“按官方公式编译的写法（格式版本 2）”各生成一个视频，保存视频与两份提示词，便于并排观看对比。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用法：先 npm run compile；设置环境变量 QIANWEN_API_KEY 后运行 node tools/real-check/qianwen-prompt-compare.js --yes；不带 --yes 只打印计划与两份提示词，不发请求；--dry-run 使用页面测试工具的假接口，不访问网络。
//       默认 480P、4 秒、两个镜头，共提交 2 次，真实调用会按平台规则计费；随机种子相同也不保证结果完全一致，仅作参考。访问密钥只从环境变量读取，不写入日志、报告或文件。仅供开发时手工验证使用，不参与打包。
// ------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_ENV_NAME = 'QIANWEN_API_KEY';
const DEFAULTS = { model: 'wan3.0-video', resolution: '480P', aspectRatio: '16:9', durationSeconds: 4, seed: 20261003, pollIntervalMs: 5000, timeoutMs: 10 * 60 * 1000 };
const DEFAULT_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1';
const DRY_RUN_POLL_INTERVAL_MS = 100;
const DRY_RUN_KEY = 'sk-dry-run';

/** 对比用的两个镜头：字段与应用里的镜头记录一致。 */
function buildShots(durationSeconds) {
  const each = durationSeconds / 2;
  const base = { sceneLabel: '第01场', continuityNote: '', firstFrameMode: 'none', firstFrameAssetId: null, entityIds: [], sounds: [], promptEn: '' };
  return [
    {
      ...base,
      id: 1,
      seq: 1,
      shotSize: '全景',
      cameraAngle: '平视',
      cameraMovement: '缓慢推近',
      durationSeconds: each,
      transition: '切',
      action: '雨夜的老街，女孩撑伞走向镜头',
      promptZh: '穿红色风衣的女孩撑着透明雨伞从远处走向镜头，雨夜的老街，路灯在湿润的石板路上投下暖黄的倒影'
    },
    {
      ...base,
      id: 2,
      seq: 2,
      shotSize: '近景',
      cameraAngle: '平视',
      cameraMovement: '固定镜头，摄影机静止',
      durationSeconds: each,
      transition: '切',
      action: '女孩抬头看向书店',
      promptZh: '女孩抬头看向前方一家亮着灯的书店，雨滴打在伞面上',
      sounds: [{ id: 1, kind: 'sfx', speakerEntityId: null, text: '雨滴打在伞面的声音', delivery: '', startOffsetSeconds: null, durationSeconds: null, isEnabled: true }]
    }
  ];
}

/** 早期写法（格式版本 1）：时间段“(0:00 - 0:02)”、声音以“声音：”开头，没有镜头语言字段、台词声明与负向清单。 */
function buildLegacyPrompt(shots) {
  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  let cursor = 0;
  const segments = shots.map((shot) => {
    const start = cursor;
    cursor += shot.durationSeconds;
    const sound = shot.sounds.map((item) => `音效：${item.text}`);
    const body = [shot.promptZh, sound.length === 0 ? '' : `声音：${sound.join('；')}`].filter(Boolean).join(' ');
    return `(${clock(start)} - ${clock(cursor)}) ${body}`;
  });
  return [`多镜头分镜，共 ${shots.length} 个镜头，按时间段依次呈现，镜头之间自然切换：`, ...segments].join('\n');
}

/** 新写法（格式版本 2）：直接调用应用里的编译函数。 */
function buildCurrentPrompt(shots, capability, options, style) {
  const { planGroupRequest } = require('../../out/domain/rules/generation-rules');
  const snapshot = planGroupRequest({
    shots,
    storyboardRunId: 0,
    providerCode: 'qianwen',
    modelCode: options.model,
    capability,
    params: { modelId: 0, aspectRatio: options.aspectRatio, resolution: options.resolution, audioMode: 'native', audioElements: null, seed: options.seed, durationSeconds: options.durationSeconds, negativeList: null, promptExtend: null },
    entities: [],
    style
  });
  return snapshot.prompt;
}

function parseArguments(argv) {
  const options = { ...DEFAULTS, yes: false, dryRun: false, out: null, style: '电影感，青蓝色调，雨夜氛围' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--yes') options.yes = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--model') options.model = argv[++index];
    else if (argument === '--duration') options.durationSeconds = Number(argv[++index]);
    else if (argument === '--resolution') options.resolution = argv[++index];
    else if (argument === '--ratio') options.aspectRatio = argv[++index];
    else if (argument === '--seed') options.seed = Number(argv[++index]);
    else if (argument === '--style') options.style = argv[++index];
    else if (argument === '--out') options.out = argv[++index];
    else throw new Error(`不认识的参数：${argument}`);
  }
  if (!Number.isInteger(options.durationSeconds) || options.durationSeconds < 2) throw new Error('--duration 必须是不小于 2 的整数。');
  return options;
}

/** 等待任务结束，返回结果；失败或超时抛出。 */
async function waitForTask(provider, ref, context, options) {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > options.timeoutMs) throw new Error(`任务 ${ref.remoteJobId} 超时。`);
    const task = await provider.query(ref, context);
    if (task.status === 'succeeded') return { result: task.result, seconds: Math.round((Date.now() - startedAt) / 100) / 10 };
    if (task.status !== 'pending' && task.status !== 'running') throw new Error(`任务 ${ref.remoteJobId} 结束为 ${task.status}：${task.errorCode ?? ''} ${task.errorMessage ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { QIANWEN_VIDEO_MODELS } = require('../../out/infra/providers/qianwen/qianwen-catalog');
  const model = QIANWEN_VIDEO_MODELS.find((item) => item.code === options.model);
  if (model === undefined) throw new Error(`没有模型 ${options.model}。`);
  const shots = buildShots(options.durationSeconds);
  const variants = [
    { name: 'v1-legacy', title: '早期写法（格式版本 1）', prompt: buildLegacyPrompt(shots) },
    { name: 'v2-current', title: '官方公式写法（格式版本 2）', prompt: buildCurrentPrompt(shots, model.capability, options, options.style) }
  ];
  console.log(`计划：${options.model}，${options.resolution}，${options.aspectRatio}，${options.durationSeconds} 秒，种子 ${options.seed}，带原生声音，共提交 ${variants.length} 次。${options.dryRun ? '（假接口，不计费）' : '真实调用会按平台规则计费。'}`);
  for (const variant of variants) console.log(`\n--- ${variant.title} ---\n${variant.prompt}`);

  if (options.dryRun) {
    require('../page-harness/fake-qianwen').installFakeQianwen();
    options.pollIntervalMs = DRY_RUN_POLL_INTERVAL_MS;
  } else {
    if (!options.yes) {
      console.log('\n没有加 --yes，只打印计划与提示词，不发起请求。');
      return;
    }
    if (!process.env[KEY_ENV_NAME]) throw new Error(`请先设置环境变量 ${KEY_ENV_NAME}。`);
  }

  const outputDirectory = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-prompt-compare-'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const { QianwenVideoProvider } = require('../../out/infra/providers/qianwen/qianwen-video-provider');
  const provider = new QianwenVideoProvider(globalThis.fetch);
  const context = { apiKey: options.dryRun ? DRY_RUN_KEY : process.env[KEY_ENV_NAME], settings: { endpoint: DEFAULT_ENDPOINT } };
  const records = [];
  for (const variant of variants) {
    console.log(`\n${variant.title}：提交……`);
    const ref = await provider.submit(
      {
        modelCode: options.model,
        prompt: variant.prompt,
        firstFrame: null,
        lastFrame: null,
        referenceImages: [],
        referenceAudios: [],
        aspectRatio: options.aspectRatio,
        resolution: options.resolution,
        durationSeconds: options.durationSeconds,
        audioMode: 'native',
        seed: options.seed,
        extraParams: {}
      },
      context
    );
    const { result, seconds } = await waitForTask(provider, ref, context, options);
    const download = await globalThis.fetch(result.videoUrl);
    if (!download.ok) throw new Error(`${variant.title}下载结果失败（HTTP ${download.status}）。`);
    const videoPath = path.join(outputDirectory, `${variant.name}.mp4`);
    fs.writeFileSync(videoPath, Buffer.from(await download.arrayBuffer()));
    fs.writeFileSync(path.join(outputDirectory, `${variant.name}.txt`), variant.prompt);
    records.push({ name: variant.name, taskId: ref.remoteJobId, seconds, bytes: fs.statSync(videoPath).size });
    console.log(`${variant.title}：完成，用时 ${seconds} 秒，${videoPath}`);
  }
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), options: { ...options, yes: undefined }, records }, null, 2));
  console.log(`\n两个视频与提示词保存在：${outputDirectory}`);
}

main().catch((error) => {
  console.error(`对比失败：${error.message}`);
  process.exitCode = 1;
});
