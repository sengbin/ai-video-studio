// ------------------------------------------------------------------------
// 名称：fake-qianwen.js
// 说明：页面测试工具使用的假千问视频接口：拦截全局 fetch，模拟创建任务、查询任务和下载结果视频，用于不访问网络、不花费额度地验证生成工作台。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：行为约定：访问密钥必须以 sk- 开头，否则返回 401；提示词包含“违规”时任务失败并返回内容审核错误；其余任务经过排队、生成中后成功；其他地址的请求交给真实的 fetch。
// ------------------------------------------------------------------------

'use strict';

const CREATE_PATH = '/services/aigc/video-generation/video-synthesis';
const TASK_PATH = /\/tasks\/([^/?]+)$/;
const FAKE_RESULT_HOST = 'https://fake-oss.example.com/';
/** 查询到最终结果之前经历的状态。 */
const PENDING_POLLS = 1;
const RUNNING_POLLS = 1;

/** 以 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 读取请求头（兼容 Headers 与普通对象）。 */
function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

/** 安装假的千问接口。 */
function installFakeQianwen() {
  const realFetch = globalThis.fetch;
  const tasks = new Map();
  let nextTaskNumber = 1;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();

    if (url.startsWith(FAKE_RESULT_HOST)) {
      return new Response(Buffer.from('fake-mp4-content'), { status: 200 });
    }

    if (url.includes('/api/v1') && url.endsWith(CREATE_PATH) && method === 'POST') {
      if (!String(readHeader(init.headers, 'Authorization') ?? '').startsWith('Bearer sk-')) {
        return jsonResponse({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 401);
      }
      const body = JSON.parse(init.body);
      const taskId = `fake-task-${nextTaskNumber++}`;
      tasks.set(taskId, { prompt: String(body.input?.prompt ?? ''), duration: body.parameters?.duration, polls: 0 });
      return jsonResponse({ request_id: `request-${taskId}`, output: { task_id: taskId, task_status: 'PENDING' } });
    }

    const taskMatch = TASK_PATH.exec(url);
    if (url.includes('/api/v1') && taskMatch && method === 'GET') {
      const task = tasks.get(decodeURIComponent(taskMatch[1]));
      if (task === undefined) {
        return jsonResponse({ code: 'InvalidParameter', message: 'task not found' }, 404);
      }
      task.polls += 1;
      if (task.polls <= PENDING_POLLS) return jsonResponse({ output: { task_status: 'PENDING' } });
      if (task.polls <= PENDING_POLLS + RUNNING_POLLS) return jsonResponse({ output: { task_status: 'RUNNING' } });
      if (task.prompt.includes('违规')) {
        return jsonResponse({
          output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }
        });
      }
      return jsonResponse({
        output: { task_status: 'SUCCEEDED', video_url: `${FAKE_RESULT_HOST}${taskMatch[1]}.mp4?Expires=1` },
        usage: { output_video_duration: task.duration > 0 ? task.duration : 5 }
      });
    }

    return realFetch(input, init);
  };
}

module.exports = { installFakeQianwen };
