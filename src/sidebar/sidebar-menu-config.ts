// ------------------------------------------------------------------------
// 名称：sidebar-menu-config.ts
// 说明：侧栏菜单的结构与文案配置，页面按该配置渲染分区和菜单行。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅描述展示内容，不包含任何交互行为。
// ------------------------------------------------------------------------

/** 侧栏菜单行：一个主入口，可带一个尾部次要操作。 */
export interface SidebarMenuItem {
  readonly id: string;
  /** 主入口文案。 */
  readonly title: string;
  /** 尾部次要操作文案；缺省表示该行没有尾部操作。 */
  readonly actionLabel?: string;
  /** 标题后的小标签，如“预览”；缺省表示不显示。 */
  readonly badge?: string;
}

/** 分区的表面样式：stage 带阴影（亮主题），flat 无阴影。 */
export type SidebarSectionSurface = 'stage' | 'flat';

/** 侧栏分区：一个标题和一组菜单行。 */
export interface SidebarMenuSection {
  readonly id: string;
  readonly title: string;
  readonly surface: SidebarSectionSurface;
  readonly items: readonly SidebarMenuItem[];
}

/** 侧栏菜单分区，按制作顺序从上到下排列：项目、创作、脚本、资产、视频、设置。 */
export const SIDEBAR_SECTIONS: readonly SidebarMenuSection[] = [
  {
    id: 'project',
    title: '项目',
    surface: 'flat',
    items: [{ id: 'project-list', title: '所有项目', actionLabel: '创建' }]
  },
  {
    id: 'creation',
    title: '创作',
    surface: 'stage',
    items: [
      { id: 'text-inspiration', title: '文字灵感', actionLabel: '添加' },
      { id: 'image-inspiration', title: '图片灵感', actionLabel: '添加' },
      { id: 'novel-adaptation', title: '小说改编', actionLabel: '添加' }
    ]
  },
  {
    id: 'script',
    title: '脚本',
    surface: 'stage',
    items: [
      { id: 'screenplay', title: '剧本', actionLabel: '添加' },
      { id: 'storyboard-script', title: '分镜', actionLabel: '添加' }
    ]
  },
  {
    id: 'asset',
    title: '资产',
    surface: 'stage',
    items: [
      { id: 'character', title: '角色', actionLabel: '添加' },
      { id: 'scene', title: '场景', actionLabel: '添加' },
      { id: 'prop', title: '道具', actionLabel: '添加' },
      { id: 'effect', title: '特效', actionLabel: '添加' },
      { id: 'audio', title: '音频', actionLabel: '添加' }
    ]
  },
  {
    id: 'video',
    title: '视频',
    surface: 'stage',
    items: [{ id: 'video-workbench', title: '生成工作台' }]
  },
  {
    id: 'settings',
    title: '设置',
    surface: 'flat',
    items: [
      { id: 'model-settings', title: '模型' },
      { id: 'data-backup', title: '数据备份', badge: '预览' }
    ]
  }
];
