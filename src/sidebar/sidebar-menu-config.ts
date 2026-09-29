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

/** 侧栏菜单分区，按页面从上到下的顺序排列。 */
export const SIDEBAR_SECTIONS: readonly SidebarMenuSection[] = [
  {
    id: 'project',
    title: '项目',
    surface: 'flat',
    items: [{ id: 'project-management', title: '项目管理', actionLabel: '创建' }]
  },
  {
    id: 'task',
    title: '任务',
    surface: 'stage',
    items: [
      { id: 'creative-writing', title: '创意写作', actionLabel: '添加' },
      { id: 'image-inspired-writing', title: '图片灵感写作', actionLabel: '添加' },
      { id: 'novel-recreation', title: '小说重创作', actionLabel: '添加' }
    ]
  },
  {
    id: 'asset',
    title: '资产',
    surface: 'stage',
    items: [
      { id: 'character-generation', title: '角色生成', actionLabel: '添加' },
      { id: 'scene-generation', title: '场景生成', actionLabel: '添加' },
      { id: 'prop-generation', title: '道具生成', actionLabel: '添加' },
      { id: 'effect-generation', title: '特效生成', actionLabel: '添加' }
    ]
  },
  {
    id: 'shooting',
    title: '拍摄',
    surface: 'stage',
    items: [
      { id: 'screenplay', title: '剧本创作', actionLabel: '添加' },
      { id: 'shooting-script', title: '拍摄脚本制作', actionLabel: '添加' }
    ]
  },
  {
    id: 'configuration',
    title: '配置',
    surface: 'flat',
    items: [
      { id: 'model-config', title: '模型配置（预览）', actionLabel: '添加' },
      { id: 'database-backup', title: '数据库备份（预览）' }
    ]
  }
];
