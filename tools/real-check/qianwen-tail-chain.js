// ------------------------------------------------------------------------
// 名称：qianwen-tail-chain.js
// 说明：千问AI平台万相 3.0 视频的真实调用实测脚本：按镜头组顺序生成视频，每组用上一组结果视频的最后一帧作首帧，记录请求体大小、排队与生成耗时、用量字段、限流相关响应头，并用 SSIM 衡量下一组第一帧与输入尾帧的衔接程度。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用法：先 npm run compile；设置环境变量 QIANWEN_API_KEY 后运行 node tools/real-check/qianwen-tail-chain.js --yes；不带 --yes 只打印计划，不发请求；--dry-run 使用页面测试工具的假接口与假密钥，不访问网络。
//       真实调用会按平台规则计费；访问密钥只从环境变量读取，不写入日志、报告或文件。需要 ffmpeg、ffprobe（在 PATH 中，或用 FFMPEG_PATH、FFPROBE_PATH 指定）。仅供开发时手工验证使用，不参与打包。
// ------------------------------------------------------------------------

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- 配置：可用命令行参数覆盖 ----

const KEY_ENV_NAME = 'QIANWEN_API_KEY';
const DEFAULTS = {
  model: 'wan3.0-video',
  groups: 3,
  /** 每组时长（秒），平分给组内两个镜头。 */
  durationSeconds: 4,
  resolution: '480P',
  aspectRatio: '16:9',
  pollIntervalMs: 5000,
  timeoutMs: 10 * 60 * 1000
};
const DEFAULT_ENDPOINT = 'https://maas.qianwenaiapi.com/api/v1';
const DRY_RUN_POLL_INTERVAL_MS = 100;
const DRY_RUN_KEY = 'sk-dry-run';
/** 从结束前这么多秒开始连续解码，保留最后一帧；比只截一帧稳，不受帧率影响。 */
const TAIL_WINDOW_SECONDS = 0.5;
/** 计算 SSIM 前统一缩放到的边长。 */
const SSIM_SIZE = 320;
/** 记录响应头时只保留名称匹配的项（限流、请求标识）。 */
const INTERESTING_HEADER = /rate|limit|retry|request-id|quota/i;
/** 每个镜头组的两个镜头；同一个女孩、同一条街，便于肉眼判断衔接。 */
const SCENES = [
  ['全景：雨夜的老街，穿红色风衣的女孩撑着透明雨伞从远处走向镜头，路灯在湿润的石板路上投下暖黄的倒影', '中景：女孩继续向前走，雨滴打在伞面上，她抬头看向前方一家亮着灯的书店'],
  ['中景：女孩走到书店门口停下，收起雨伞，抖落伞面上的水珠', '近景：女孩伸手推开木门，门上的铃铛轻轻作响，暖色的光从店内洒出来'],
  ['中景：女孩走进书店，高大的书架排满两侧，暖色灯光柔和，她环顾四周', '特写：女孩的手指划过一排旧书的书脊，停在一本蓝色封面的书上']
];

// ---- 参数与文本 ----

/** 解析命令行：--键 值 或 --开关。 */
function parseArguments(argv) {
  const options = { ...DEFAULTS, yes: false, dryRun: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--yes') options.yes = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--model') options.model = argv[++index];
    else if (argument === '--groups') options.groups = Number(argv[++index]);
    else if (argument === '--duration') options.durationSeconds = Number(argv[++index]);
    else if (argument === '--resolution') options.resolution = argv[++index];
    else if (argument === '--ratio') options.aspectRatio = argv[++index];
    else if (argument === '--out') options.out = argv[++index];
    else throw new Error(`不认识的参数：${argument}`);
  }
  if (!Number.isInteger(options.groups) || options.groups < 2 || options.groups > SCENES.length) {
    throw new Error(`--groups 必须是 2 到 ${SCENES.length} 的整数。`);
  }
  if (!Number.isInteger(options.durationSeconds) || options.durationSeconds < 2) {
    throw new Error('--duration 必须是不小于 2 的整数。');
  }
  return options;
}

/** 毫秒转为一位小数的秒。 */
function seconds(milliseconds) {
  return Math.round(milliseconds / 100) / 10;
}

/** 把秒数格式化为 m:ss。 */
function formatTimestamp(totalSeconds) {
  return `${Math.floor(totalSeconds / 60)}:${String(Math.round(totalSeconds % 60)).padStart(2, '0')}`;
}

/** 构造一组的多镜头提示词，格式与应用编译镜头组时一致。 */
function buildPrompt(scenes, durationSeconds) {
  const each = durationSeconds / scenes.length;
  const segments = scenes.map((scene, index) => `(${formatTimestamp(index * each)} - ${formatTimestamp((index + 1) * each)}) ${scene}`);
  return [`多镜头分镜，共 ${scenes.length} 个镜头，按时间段依次呈现，镜头之间自然切换：`, ...segments].join('\n');
}

// ---- ffmpeg ----

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

/** 运行外部命令，失败时抛出带输出的错误；返回标准输出与标准错误。 */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`无法运行 ${command}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 失败（${result.status}）：${String(result.stderr).slice(-600)}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

/** 截取视频的最后一帧为 JPEG。 */
function extractTailFrame(video, output) {
  run(FFMPEG, ['-y', '-v', 'error', '-sseof', `-${TAIL_WINDOW_SECONDS}`, '-i', video, '-update', '1', '-q:v', '2', output]);
}

/** 截取视频的第一帧为 PNG。 */
function extractFirstFrame(video, output) {
  run(FFMPEG, ['-y', '-v', 'error', '-i', video, '-frames:v', '1', output]);
}

/** 读取视频的尺寸、时长与是否带音轨。 */
function probeVideo(video) {
  const { stdout } = run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', video]);
  const info = JSON.parse(stdout);
  const videoStream = (info.streams ?? []).find((stream) => stream.codec_type === 'video') ?? {};
  return {
    width: videoStream.width ?? null,
    height: videoStream.height ?? null,
    durationSeconds: info.format?.duration === undefined ? null : Math.round(Number(info.format.duration) * 10) / 10,
    hasAudio: (info.streams ?? []).some((stream) => stream.codec_type === 'audio')
  };
}

/** 两张图片的 SSIM（1 表示完全一致）；统一缩放后比较。 */
function measureSsim(imageA, imageB) {
  const filter = `[0:v]scale=${SSIM_SIZE}:${SSIM_SIZE}[a];[1:v]scale=${SSIM_SIZE}:${SSIM_SIZE}[b];[a][b]ssim`;
  const { stderr } = run(FFMPEG, ['-v', 'info', '-i', imageA, '-i', imageB, '-lavfi', filter, '-f', 'null', '-']);
  const matched = /All:([\d.]+)/.exec(stderr);
  return matched === null ? null : Number(matched[1]);
}

// ---- 带记录的 fetch ----

/** 去掉 URL 的查询串（结果地址带签名），只保留主机与路径。 */
function stripQuery(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** 去掉响应里带签名的地址。 */
function redactUrls(value) {
  if (Array.isArray(value)) return value.map(redactUrls);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' && item.startsWith('http') ? stripQuery(item) : redactUrls(item)]));
  }
  return value;
}

/** 包装 fetch：记录每次调用的请求体大小、状态、耗时和限流相关响应头，并保留最近一次任务查询的响应内容；不记录 Authorization。 */
function createRecordingFetch(baseFetch) {
  const calls = [];
  const state = { lastTaskBody: null };
  const recording = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const startedAt = Date.now();
    const response = await baseFetch(input, init);
    const headers = {};
    response.headers.forEach((value, name) => {
      if (INTERESTING_HEADER.test(name)) headers[name] = value;
    });
    calls.push({
      method: (init.method ?? 'GET').toUpperCase(),
      target: stripQuery(url),
      status: response.status,
      requestBytes: typeof init.body === 'string' ? Buffer.byteLength(init.body) : 0,
      elapsedMs: Date.now() - startedAt,
      headers
    });
    if (url.includes('/tasks/') && response.ok) {
      state.lastTaskBody = redactUrls(await response.clone().json());
    }
    return response;
  };
  return { recording, calls, state };
}

// ---- 主流程 ----

/** 等待任务结束，记录进入各状态的时间；超时或失败时抛出。 */
async function waitForTask(provider, ref, context, options, state) {
  const startedAt = Date.now();
  const timeline = { submittedAt: startedAt, runningAt: null, finishedAt: null };
  for (;;) {
    if (Date.now() - startedAt > options.timeoutMs) throw new Error(`任务 ${ref.remoteJobId} 超过 ${seconds(options.timeoutMs)} 秒仍未结束。`);
    const task = await provider.query(ref, context);
    if (task.status === 'running' && timeline.runningAt === null) timeline.runningAt = Date.now();
    if (task.status === 'succeeded') {
      timeline.finishedAt = Date.now();
      return { timeline, result: task.result, raw: state.lastTaskBody };
    }
    if (task.status !== 'pending' && task.status !== 'running') {
      throw new Error(`任务 ${ref.remoteJobId} 结束为 ${task.status}：${task.errorCode ?? ''} ${task.errorMessage ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

/** 逐组生成并衔接，返回每组的记录。 */
async function runChain(options, outputDirectory, fetchFunction, calls, state) {
  const { QianwenVideoProvider } = require('../../out/infra/providers/qianwen/qianwen-video-provider');
  const provider = new QianwenVideoProvider(fetchFunction);
  const context = { apiKey: options.dryRun ? DRY_RUN_KEY : process.env[KEY_ENV_NAME], settings: { endpoint: DEFAULT_ENDPOINT } };
  const groups = [];
  let previousTailFrame = null;

  for (let index = 0; index < options.groups; index += 1) {
    const label = `第 ${index + 1} 组`;
    const firstFrameData = previousTailFrame === null ? null : fs.readFileSync(previousTailFrame);
    const request = {
      modelCode: options.model,
      prompt: buildPrompt(SCENES[index], options.durationSeconds),
      firstFrame: firstFrameData === null ? null : { mimeType: 'image/jpeg', data: new Uint8Array(firstFrameData) },
      lastFrame: null,
      referenceImages: [],
      referenceAudios: [],
      aspectRatio: options.aspectRatio,
      resolution: options.resolution,
      durationSeconds: options.durationSeconds,
      audioMode: 'native',
      seed: null,
      extraParams: {}
    };
    const callsBefore = calls.length;
    console.log(`${label}：提交（首帧${firstFrameData === null ? '无' : `${firstFrameData.length} 字节`}）……`);
    const ref = await provider.submit(request, context);
    const submitCall = calls[callsBefore];
    const { timeline, result, raw } = await waitForTask(provider, ref, context, options, state);

    const videoPath = path.join(outputDirectory, `group-${index + 1}.mp4`);
    const download = await fetchFunction(result.videoUrl);
    if (!download.ok) throw new Error(`${label}下载结果失败（HTTP ${download.status}）。`);
    fs.writeFileSync(videoPath, Buffer.from(await download.arrayBuffer()));

    const video = probeVideo(videoPath);
    const record = {
      group: index + 1,
      taskId: ref.remoteJobId,
      firstFrameBytes: firstFrameData === null ? null : firstFrameData.length,
      submitBodyBytes: submitCall.requestBytes,
      submitStatus: submitCall.status,
      queueSeconds: timeline.runningAt === null ? null : seconds(timeline.runningAt - timeline.submittedAt),
      runSeconds: timeline.runningAt === null ? null : seconds(timeline.finishedAt - timeline.runningAt),
      totalSeconds: seconds(timeline.finishedAt - timeline.submittedAt),
      usage: raw?.usage ?? null,
      requestId: raw?.request_id ?? null,
      video: { ...video, bytes: fs.statSync(videoPath).size },
      ssimFirstFrameToInput: null
    };

    if (previousTailFrame !== null) {
      const firstFramePath = path.join(outputDirectory, `group-${index + 1}-first.png`);
      extractFirstFrame(videoPath, firstFramePath);
      record.ssimFirstFrameToInput = measureSsim(previousTailFrame, firstFramePath);
    }
    previousTailFrame = path.join(outputDirectory, `group-${index + 1}-tail.jpg`);
    extractTailFrame(videoPath, previousTailFrame);
    groups.push(record);
    console.log(`${label}：完成，用时 ${record.totalSeconds} 秒，${video.width}×${video.height}，${video.durationSeconds} 秒，${video.hasAudio ? '带' : '无'}音轨`);
  }
  return groups;
}

/** 汇总打印。 */
function printSummary(options, groups, calls, outputDirectory) {
  console.log('\n===== 汇总 =====');
  console.log(`模型 ${options.model}，${options.resolution}，${options.aspectRatio}，每组 ${options.durationSeconds} 秒，共 ${groups.length} 组，计费时长合计 ${groups.length * options.durationSeconds} 秒`);
  for (const group of groups) {
    console.log(
      `第 ${group.group} 组：请求体 ${group.submitBodyBytes} 字节（首帧 ${group.firstFrameBytes ?? 0}），排队 ${group.queueSeconds} 秒，生成 ${group.runSeconds} 秒，` +
        `用量 ${JSON.stringify(group.usage)}，与输入尾帧的 SSIM ${group.ssimFirstFrameToInput ?? '—'}`
    );
  }
  const limitHeaders = calls.filter((call) => Object.keys(call.headers).length > 0);
  console.log(`限流相关响应头：${limitHeaders.length === 0 ? '没有返回' : JSON.stringify(limitHeaders[0].headers)}`);
  console.log(`视频、首帧、尾帧与 report.json 保存在：${outputDirectory}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(
    `计划：${options.model}，${options.groups} 组，每组 ${options.durationSeconds} 秒，${options.resolution}，画幅 ${options.aspectRatio}，带原生声音；` +
      `后一组用前一组的最后一帧作首帧。${options.dryRun ? '（假接口，不计费）' : '真实调用会按平台规则计费。'}`
  );
  if (options.dryRun) {
    require('../page-harness/fake-qianwen').installFakeQianwen();
    options.pollIntervalMs = DRY_RUN_POLL_INTERVAL_MS;
  } else {
    if (!options.yes) {
      console.log('没有加 --yes，只打印计划，不发起请求。');
      return;
    }
    if (!process.env[KEY_ENV_NAME]) {
      throw new Error(`请先设置环境变量 ${KEY_ENV_NAME}。`);
    }
  }

  const outputDirectory = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-tail-chain-'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const { recording, calls, state } = createRecordingFetch(globalThis.fetch);
  const groups = await runChain(options, outputDirectory, recording, calls, state);
  const report = { generatedAt: new Date().toISOString(), options: { ...options, yes: undefined }, groups, calls };
  fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  printSummary(options, groups, calls, outputDirectory);
}

main().catch((error) => {
  console.error(`实测失败：${error.message}`);
  process.exitCode = 1;
});
