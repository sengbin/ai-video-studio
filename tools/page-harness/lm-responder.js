// ------------------------------------------------------------------------
// 名称：lm-responder.js
// 说明：页面测试工具用的假 Copilot 应答：按提示词中的任务标题返回符合约定的 JSON，让整条生成流程可以在没有 Copilot 的环境下跑通。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅供开发时手工验证页面使用；内容是可读的示例文字，不代表真实模型的输出质量。
// ------------------------------------------------------------------------

'use strict';

const SENTENCES = [
  '海风吹过灯塔的窗，守夜人放下手中的旧茶杯，望向漆黑的海面。',
  '远处传来一声很轻的汽笛，像是有人在很远的地方呼唤他的名字。',
  '他翻开值班日志，发现最新一页上多出了一行不属于自己的字迹。',
  '雨点敲在玻璃上，灯光每转一圈，就把浪尖照亮一次，又迅速交还给黑暗。',
  '他决定顺着信号的方向走下去，哪怕那条路早已被潮水淹没多年。'
];

/** 生成指定最少字数的示例正文。 */
function makeContent(minWords, seq) {
  let text = '';
  let index = seq;
  while (text.replace(/[^\u4e00-\u9fff]/g, '').length < minWords + 20) {
    text += SENTENCES[index % SENTENCES.length];
    index += 1;
  }
  return text;
}

/** 从提示词里读取“每章正文字数范围”的下限，读不到时用 120。 */
function readMinWords(text) {
  const match = /字数范围：(\d+) 到 (\d+) 字/.exec(text);
  return match ? Number(match[1]) : 120;
}

/** 创建应答函数：输入完整提示词，返回模型输出文本。 */
function createResponder() {
  return function respond(text) {
    if (text.includes('# 任务：提取原文要点')) {
      const index = /第 (\d+) 段/.exec(text)?.[1] ?? '';
      return JSON.stringify({ summary: `第 ${index} 段要点：人物出场、事件推进、关键设定。` });
    }
    if (text.includes('# 任务：分析灵感图片')) {
      return JSON.stringify({ summary: '画面：夜色中的灯塔与海面，冷色调，氛围孤寂。' });
    }
    if (text.includes('# 任务：规划章节大纲')) {
      const maxChapters = Number(/章节数上限：(\d+) 章/.exec(text)?.[1] ?? 3);
      const count = Math.min(3, maxChapters);
      const chapters = Array.from({ length: count }, (_, index) => ({
        title: ['开端', '转折', '结局'][index],
        summary: `第 ${index + 1} 章的梗概。`,
        sources: [index + 1]
      }));
      return JSON.stringify({ chapters });
    }
    const chapter = /# 任务：撰写第 (\d+) 章/.exec(text);
    if (chapter) {
      const seq = Number(chapter[1]);
      return JSON.stringify({ title: `第${seq}章 示例`, content: makeContent(readMinWords(text), seq) });
    }
    if (text.includes('# 任务：撰写剧本包')) {
      return JSON.stringify({
        title: '雨夜来客',
        overview: '题材：悬疑。灯塔守夜人在雨夜收到神秘信号，顺着信号找到多年前失踪的人。',
        fullText: '第一集 信号\n场景一 灯塔内 夜\n守夜人点亮灯塔，翻开值班日志。\n老陈：今晚会下雨。\n\n第二集 海面\n场景二 海边 夜\n老陈划船出海，寻找信号来源。'
      });
    }
    if (text.includes('# 任务：从剧本中抽取集和实体')) {
      const single = text.includes('这是单个短视频，只有 1 集。');
      const maxEpisodes = Number(/最多 (\d+) 集/.exec(text)?.[1] ?? 2);
      const episodes = single
        ? [{ synopsis: '守夜人在雨夜顺着信号出海。', targetDurationSeconds: 45 }]
        : [
            { title: '信号', synopsis: '守夜人收到神秘信号。', screenplayText: '场景一 灯塔内 夜\n守夜人点亮灯塔，翻开值班日志。', targetDurationSeconds: 45 },
            { title: '海面', synopsis: '老陈出海寻找信号。', screenplayText: '场景二 海边 夜\n老陈划船出海，寻找信号来源。', targetDurationSeconds: 45 }
          ].slice(0, maxEpisodes);
      return JSON.stringify({
        episodes,
        entities: [
          { kind: 'character', name: '老陈', aliases: ['守夜人'], description: '守了三十年灯塔的老人。', attributes: { identity: '灯塔守夜人', voice: '低沉沙哑' } },
          { kind: 'scene', name: '灯塔', description: '海边的旧灯塔。', attributes: { interior_exterior: '内景', time_light: '夜晚，灯光每转一圈照亮一次浪尖' } },
          { kind: 'prop', name: '值班日志', description: '记录每晚情况的旧本子。', attributes: { appearance: '深色封皮，边角磨损' } }
        ]
      });
    }
    if (text.includes('# 任务：生成分镜脚本')) {
      const silent = text.includes('这是无声视频');
      const kinds = ['dialogue', 'narration', 'sfx', 'music'].filter((kind) => text.includes(`${kind}（`));
      const withFirstFrame = text.includes('逐个镜头判断 firstFrameMode');
      const chained = text.includes('都以上一镜头的尾帧作为首帧');
      const sound = (kind, body) => (silent || !kinds.includes(kind) ? [] : [body]);
      const shots = [
        {
          sceneLabel: '第01场',
          shotSize: '远景',
          cameraAngle: '平视',
          action: '雨夜里，海边的灯塔亮起光束，扫过漆黑的海面。',
          cameraMovement: '固定',
          durationSeconds: 4,
          transition: '切',
          continuityNote: '雨夜，冷色调。',
          entities: [{ kind: 'scene', name: '灯塔' }],
          sounds: [...sound('music', { kind: 'music', text: '低沉紧张的弦乐', delivery: '渐强' }), ...sound('sfx', { kind: 'sfx', text: '海浪与风声' })],
          promptZh: '雨夜的海边灯塔，光束扫过漆黑的海面，冷色调，远景。',
          promptEn: 'A lighthouse by the sea on a rainy night, its beam sweeping across the dark water, cold tones, wide shot.'
        },
        {
          sceneLabel: '第01场',
          shotSize: '中景',
          cameraAngle: '平视',
          action: '老陈站在灯塔内的窗边，翻开值班日志，眉头渐渐皱起。',
          cameraMovement: '缓慢推进',
          durationSeconds: 5,
          transition: '切',
          continuityNote: '老陈的服装与光线与上一镜头保持一致。',
          entities: [{ kind: 'character', name: '老陈' }, { kind: 'prop', name: '值班日志' }, { kind: 'scene', name: '灯塔' }],
          sounds: [...sound('dialogue', { kind: 'dialogue', speaker: '老陈', text: '今晚会下雨。', delivery: '低声、沙哑' })],
          promptZh: '灯塔内，老人在窗边翻开旧日志，神情凝重，中景，缓慢推进。',
          promptEn: 'Inside the lighthouse, an old man opens a worn logbook by the window with a grave expression, medium shot, slow push-in.'
        },
        {
          sceneLabel: '第02场',
          shotSize: '特写',
          cameraAngle: '俯拍',
          action: '日志最新一页上出现一行陌生的字迹，雨水沿着窗沿滴落。',
          cameraMovement: '固定',
          durationSeconds: 3,
          transition: '切',
          continuityNote: '',
          entities: [{ kind: 'prop', name: '值班日志' }],
          sounds: [...sound('narration', { kind: 'narration', text: '那行字，不是他写的。' })],
          promptZh: '旧日志页面特写，陌生的字迹，雨水滴落在窗沿。',
          promptEn: 'Close-up of a logbook page with unfamiliar handwriting, rain dripping on the windowsill.'
        }
      ].map((shot, index) => {
        const result = { ...shot };
        if (!silent && !kinds.length) result.sounds = [];
        if (withFirstFrame) result.firstFrameMode = index === 1 ? 'prev_tail' : 'none';
        if (chained) delete result.firstFrameMode;
        return result;
      });
      return JSON.stringify({ shots });
    }
    return JSON.stringify({ refused: '示例应答无法处理该任务。' });
  };
}

module.exports = { createResponder };
