// ------------------------------------------------------------------------
// 名称：option-sets.ts
// 说明：表单选项集的初始值：视觉风格、视频画幅、分辨率、创意题材与基调、资产的构图、背景、画幅与风格。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：视频画幅与分辨率在模型能力描述可用后，改由所选模型的能力决定。
// ------------------------------------------------------------------------

/** 视觉风格预置项；风格允许自定义，不限于此列表。 */
export const VISUAL_STYLE_OPTIONS: readonly string[] = [
  '写实电影风格',
  '写实摄影',
  '2D动漫插画',
  '3D动画风格',
  '游戏概念设计',
  '水彩插画',
  '黑白线稿'
];

/** 视频画幅的通用选项。 */
export const VIDEO_ASPECT_RATIO_OPTIONS: readonly string[] = ['16:9', '9:16', '1:1', '4:3', '3:4'];

/** 视频分辨率的通用选项。 */
export const VIDEO_RESOLUTION_OPTIONS: readonly string[] = ['480P', '720P', '1080P'];

/** 创意题材预置项；题材允许自定义，不限于此列表。 */
export const GENRE_OPTIONS: readonly string[] = ['悬疑', '爱情', '科幻', '奇幻', '喜剧', '现实题材', '历史', '武侠', '冒险', '恐怖'];

/** 创意基调预置项；基调允许自定义，不限于此列表。 */
export const TONE_OPTIONS: readonly string[] = ['紧张', '温情', '热血', '轻松幽默', '压抑', '浪漫'];

/** 角色类型预置项；允许自定义。 */
export const CHARACTER_TYPE_OPTIONS: readonly string[] = ['人类', '动物', '怪物', '丧尸', '其他'];

/** 音色参考音频的语言。 */
export const AUDIO_LANGUAGE_OPTIONS: readonly string[] = ['中文', '英文', '其他'];

/** 某类资产（图像类）的视角与构图、背景、参考图画幅、画面风格选项。 */
export interface AssetOptionSet {
  readonly composition: readonly string[];
  readonly background: readonly string[];
  readonly aspectRatio: readonly string[];
  readonly style: readonly string[];
}

/** 图像类资产各自的选项集；音频资产不使用。 */
export const ASSET_OPTION_SETS: Readonly<Record<'character' | 'scene' | 'prop' | 'effect', AssetOptionSet>> = {
  character: {
    composition: ['正面全身像', '三视图（正面、侧面、背面）', '正面半身像', '侧面全身像', '面部特写'],
    background: ['纯白背景', '浅灰纯色背景', '纯色背景', '简洁渐变背景', '与角色设定相符的环境背景'],
    aspectRatio: ['2:3', '3:2', '1:1', '4:3', '16:9', '9:16'],
    style: VISUAL_STYLE_OPTIONS
  },
  scene: {
    composition: ['平视广角全景', '入口方向全景', '俯视布局图', '轴测空间图', '局部区域特写'],
    background: ['完整环境场景', '与场景设定相符的环境背景', '简洁纯色背景', '简洁渐变背景', '纯白背景'],
    aspectRatio: ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1'],
    style: ['写实电影风格', '写实摄影', '建筑可视化', '3D场景渲染', '游戏概念设计', '2D动漫背景', '水彩插画']
  },
  prop: {
    composition: ['单体居中展示', '三视图（正面、侧面、背面）', '正面图', '45度产品视角', '细节特写'],
    background: ['纯白产品背景', '浅灰产品背景', '深色产品背景', '简洁渐变背景', '与道具用途相符的环境背景'],
    aspectRatio: ['1:1', '4:3', '3:2', '2:3', '16:9'],
    style: [...VISUAL_STYLE_OPTIONS, '产品摄影', '微距摄影']
  },
  effect: {
    composition: ['特效主体居中', '中近景', '广角全景', '关键帧主体特写'],
    background: ['透明背景', '纯黑背景', '深色渐变背景', '中性纯色背景', '与特效场景相符的环境背景'],
    aspectRatio: ['16:9', '9:16', '1:1', '4:3', '3:2', '2.39:1'],
    style: ['写实电影特效', '科幻能量特效', '魔法粒子特效', '烟雾与火焰特效', '2D动漫特效', '3D特效渲染', '游戏特效概念设计']
  }
};