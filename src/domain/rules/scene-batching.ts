// ------------------------------------------------------------------------
// 名称：scene-batching.ts
// 说明：分镜脚本按场次分批的规则：按“第N场”标题行把一集剧本正文切成场次，再把相邻场次按字数打包成批，每批单独调用模型生成镜头。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数；正文不超过单批字数上限，或没有识别出两个以上场次时只有一批（整集一次调用）；单个场次超过上限时独占一批，不在场次中间切开。
// ------------------------------------------------------------------------

/** 单批剧本正文的字数上限：超过时才分批。镜头数大致随正文长度增长，上限用于避免单次输出过长；待真实模型实测后调整。 */
export const SCENE_BATCH_MAX_CHARS = 3000;

/** 场次标题行：以“第N场”开头（可带 Markdown 井号），N 为阿拉伯数字或中文数字，与分镜工具中 sceneLabel 的“第01场”写法一致。 */
const SCENE_HEADING = /^\s*(?:#{1,6}\s*)?第\s*[0-9０-９一二三四五六七八九十百零两]+\s*场/;

/** 一批：连续的若干场次。 */
export interface SceneBatch {
  /** 本批的剧本正文。 */
  readonly text: string;
  /** 本批第一个与最后一个场次的标题行（去除首尾空白）；没有识别出场次时为空串。 */
  readonly firstHeading: string;
  readonly lastHeading: string;
  readonly sceneCount: number;
}

/** 切出的一个场次：标题行与正文（含标题行）。 */
interface SceneBlock {
  readonly heading: string;
  readonly text: string;
}

/**
 * 按场次标题行切分剧本正文；第一个标题之前的内容并入第一个场次。没有标题时返回空数组。
 * @param text 一集的剧本正文。
 */
export function splitScenes(text: string): SceneBlock[] {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => (SCENE_HEADING.test(line) ? [index] : []));
  return starts.map((start, position) => {
    const from = position === 0 ? 0 : start;
    const to = position === starts.length - 1 ? lines.length : starts[position + 1];
    return { heading: lines[start].trim(), text: lines.slice(from, to).join('\n') };
  });
}

/**
 * 把一集剧本正文打包成批。
 * @param text 一集的剧本正文。
 * @param maxChars 单批字数上限。
 * @returns 至少一批；不分批时只有一批，正文原样保留。
 */
export function planSceneBatches(text: string, maxChars: number = SCENE_BATCH_MAX_CHARS): SceneBatch[] {
  const scenes = splitScenes(text);
  if (text.length <= maxChars || scenes.length < 2) {
    return [{ text, firstHeading: scenes[0]?.heading ?? '', lastHeading: scenes.at(-1)?.heading ?? '', sceneCount: scenes.length }];
  }
  const batches: SceneBatch[] = [];
  let current: SceneBlock[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      batches.push({
        text: current.map((scene) => scene.text).join('\n'),
        firstHeading: current[0].heading,
        lastHeading: current[current.length - 1].heading,
        sceneCount: current.length
      });
    }
    current = [];
  };
  for (const scene of scenes) {
    const used = current.reduce((sum, item) => sum + item.text.length + 1, 0);
    if (current.length > 0 && used + scene.text.length > maxChars) {
      flush();
    }
    current.push(scene);
  }
  flush();
  return batches;
}
