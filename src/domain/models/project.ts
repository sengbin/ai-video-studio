// ------------------------------------------------------------------------
// 名称：project.ts
// 说明：项目领域模型：项目、项目摘要、提交输入和删除影响统计。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：视觉风格、默认画幅、默认分辨率为空表示未设置。
// ------------------------------------------------------------------------

/** 创建或修改项目时提交的内容，已经过规范化。 */
export interface ProjectInput {
  readonly name: string;
  readonly description: string;
  readonly visualStyle: string | null;
  readonly defaultAspectRatio: string | null;
  readonly defaultResolution: string | null;
}

/** 项目。 */
export interface Project extends ProjectInput {
  readonly id: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 项目列表中的一行：项目及其作品数。 */
export interface ProjectSummary extends Project {
  readonly workCount: number;
}

/** 删除项目时会一并删除的内容数量（资产不属于项目，不受影响）。 */
export interface ProjectDeletionImpact {
  readonly workCount: number;
  readonly videoResultCount: number;
}
