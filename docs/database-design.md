# 数据库设计

本文是 AIGC Video Studio（AIGC 视频工作室）的本地数据库设计说明，与 [ARCHITECTURE.md](ARCHITECTURE.md) 配套；页面与表单如何写入这些数据，见 [page-form-design.md](page-form-design.md)。

## 1. 总体约定

| 项 | 约定 |
|---|---|
| 数据库 | SQLite 单文件，位于扩展全局存储目录；使用 Node 内置的 `node:sqlite` 访问 |
| 版本管理 | 用 `PRAGMA user_version` 记录结构版本；迁移脚本放在 `infra/database/migrations/`，启动时自动升级 |
| 外键 | 每次打开连接都执行 `PRAGMA foreign_keys = ON` |
| 主键 | 每表一个 `id`，整数自增 |
| 表名、字段名 | 小写下划线，表名用复数 |
| 时间 | 文本，ISO 8601 UTC，例如 `2026-09-30T08:00:00.000Z`；字段名以 `_at` 结尾 |
| 布尔 | 整数 0 或 1，字段名用 `is_` 开头 |
| 枚举 | 文本，用 CHECK 约束限定取值 |
| JSON | 文本，用 `json_valid()` 校验；只存无需查询和关联的内容 |
| 二进制 | 只存图片和音频（资产图、资产音频、资产生成版本的文件、尾帧）；视频结果存文件，库中只存相对路径 |
| 密钥 | 不入库，存 VS Code `SecretStorage` |
| 空值 | 参数类字段为空表示“沿用上一级”，不表示 0 或空串；可选的外键为空（`NULL`）表示“没有关联”（如资产不分类、镜头未分组），不用 0 表示“无”，0 违反外键约束 |

## 2. 表总览

| 分组 | 表 | 作用 |
|---|---|---|
| 项目与作品 | `projects` | 项目及项目级默认值 |
| | `works` | 作品，一个作品是单个短视频或一部多集短片 |
| | `work_sources` | 创意阶段的素材附件（图片、小说原文） |
| | `stage_runs` | 各阶段的每次生成记录，保存输入快照、版本、进度和人工确认状态 |
| | `chapters` | 创意阶段产出的章节正文 |
| 剧本 | `screenplays` | 剧本包 |
| | `episodes` | 集 |
| | `script_entities` | 脚本实体（角色、场景、道具、特效） |
| 分镜脚本 | `storyboard_scripts` | 某一集的分镜脚本 |
| | `shots` | 镜头 |
| | `shot_groups` | 镜头组：相邻镜头打包成的一次视频生成单位 |
| | `shot_entities` | 镜头与出场实体的关系 |
| | `shot_sounds` | 镜头的声音条目：对白、旁白、音效、配乐 |
| 资产 | `assets` | 全局资产，不属于项目，所有项目共用 |
| | `asset_categories` | 资产分类：属于某个资产类型，同类型内名称唯一（迁移 013） |
| | `asset_files` | 资产图片 |
| | `asset_versions` | 资产的生成版本：每次提交给图像、音频模型产生一个，同时记录任务状态（迁移 009） |
| | `asset_version_files` | 版本的生成结果文件：图片或音频（迁移 009） |
| | `entity_bindings` | 集内“脚本实体与资产”的绑定 |
| 模型与参数 | `providers` | 模型服务商 |
| | `models` | 模型 |
| | `model_capabilities` | 模型能力描述 |
| | `generation_profiles` | 三级生成参数（作品、集、镜头组） |
| 生成 | `video_jobs` | 镜头组生成任务 |
| | `video_results` | 生成结果视频 |
| | `result_frames` | 结果视频的尾帧图片 |
| | `episode_audio_tracks` | 集的独立音轨（预留，本阶段不开发） |

共 27 张表，其中 `episode_audio_tracks` 为预留，实际创建 26 张（迁移 009 已创建 `asset_versions`、`asset_version_files`，迁移 013 创建 `asset_categories`）。

## 3. 关系图

```mermaid
erDiagram
  projects ||--o{ works : 包含
  works ||--o{ work_sources : 素材
  works ||--o{ stage_runs : 生成记录
  works ||--o{ episodes : 包含
  works ||--o{ script_entities : 脚本实体
  stage_runs ||--o{ chapters : 产出
  stage_runs ||--o| screenplays : 产出
  stage_runs ||--o| storyboard_scripts : 产出
  stage_runs }o--o| stage_runs : 上游记录
  assets ||--o{ asset_versions : 生成版本
  asset_categories |o--o{ assets : 分类
  asset_versions ||--o{ asset_version_files : 版本文件
  episodes ||--o{ storyboard_scripts : 分镜脚本
  storyboard_scripts ||--o{ shots : 镜头
  storyboard_scripts ||--o{ shot_groups : 分组
  shot_groups ||--o{ shots : 成员
  shots ||--o{ shot_entities : 出场
  script_entities ||--o{ shot_entities : 被引用
  shots ||--o{ shot_sounds : 声音
  script_entities ||--o{ shot_sounds : 说话人
  assets ||--o{ shot_sounds : 指定音频
  episodes ||--o{ episode_audio_tracks : 独立音轨（预留）
  episodes ||--o{ entity_bindings : 绑定
  script_entities ||--o{ entity_bindings : 被绑定
  assets ||--o{ entity_bindings : 被绑定
  assets ||--o{ asset_files : 图片
  providers ||--o{ models : 提供
  models ||--|| model_capabilities : 能力
  works ||--o| generation_profiles : 作品参数
  episodes ||--o| generation_profiles : 集参数
  shot_groups ||--o| generation_profiles : 镜头组参数
  models ||--o{ generation_profiles : 指定
  shot_groups ||--o{ video_jobs : 提交
  models ||--o{ video_jobs : 执行
  video_jobs ||--o{ video_results : 产出
  video_jobs }o--o| video_jobs : 前序镜头
  video_results ||--o| result_frames : 尾帧
  video_jobs }o--o| result_frames : 首帧
```

## 4. 表结构

以下“必填”指列定义为 NOT NULL。“默认”栏为空表示无默认值。

### 4.1 项目与作品

#### `projects` 项目

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | 主键 |
| `name` | 文本 | 是 | | 项目名称，唯一 |
| `description` | 文本 | 是 | 空串 | 项目描述 |
| `visual_style` | 文本 | 否 | | 项目视觉风格，分镜脚本默认沿用；从实体新建资产时预填为资产的画面风格（资产不再沿用项目风格） |
| `default_aspect_ratio` | 文本 | 否 | | 默认画幅，如 `16:9` |
| `default_resolution` | 文本 | 否 | | 默认分辨率，如 `1080P` |
| `created_at` | 文本 | 是 | | 创建时间 |
| `updated_at` | 文本 | 是 | | 更新时间 |

#### `works` 作品

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | 主键 |
| `project_id` | 整数 | 是 | | 所属项目，外键 `projects.id`，级联删除 |
| `name` | 文本 | 是 | | 作品名称，同一项目内唯一 |
| `kind` | 文本 | 是 | | `single` 单个短视频、`series` 多集短片 |
| `source_type` | 文本 | 否 | | 创意素材来源：`text`、`image`、`novel` |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：`(project_id, name)` 唯一。

#### `work_sources` 素材附件

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `work_id` | 整数 | 是 | | 外键 `works.id`，级联删除 |
| `kind` | 文本 | 是 | | `image`、`novel_text` |
| `file_name` | 文本 | 是 | | 原始文件名 |
| `mime` | 文本 | 是 | | 如 `image/png`、`text/plain` |
| `size_bytes` | 整数 | 是 | | 文件大小 |
| `content` | 二进制 | 是 | | 文件内容 |
| `sort_order` | 整数 | 是 | 0 | 图片顺序，影响“按上传顺序展开” |
| `created_at` | 文本 | 是 | | |

#### `stage_runs` 阶段生成记录

每次生成创意、剧本或分镜脚本，都产生一条记录，保存当时的输入、进度和人工确认状态，便于重新生成与追溯。产出写在各阶段自己的表（`chapters`、`screenplays`、`storyboard_scripts`）中，确认流程见 [ARCHITECTURE.md](ARCHITECTURE.md) 6.3。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `work_id` | 整数 | 是 | | 外键 `works.id`，级联删除 |
| `episode_id` | 整数 | 否 | | 外键 `episodes.id`，级联删除；仅分镜脚本阶段使用 |
| `stage` | 文本 | 是 | | `creative`、`screenplay`、`storyboard_script` |
| `version` | 整数 | 是 | | 同一作品、阶段、集下的序号，从 1 递增 |
| `input_json` | 文本（JSON） | 是 | | 表单输入快照，见“提示输入”字段 |
| `status` | 文本 | 是 | `running` | 生成状态：`running`、`succeeded`、`failed`、`canceled` |
| `review_status` | 文本 | 是 | `pending` | 确认状态：`pending` 待确认、`approved` 已确认；只有 `status = succeeded` 时才可为 `approved` |
| `is_current` | 整数 | 是 | 0 | 是否为当前采用的版本；为 1 时必须已确认 |
| `revision` | 整数 | 是 | 1 | 修订号，产出内容每被编辑保存一次加 1，用于判断下游是否过期 |
| `source_run_id` | 整数 | 否 | | 依赖的上游阶段记录，外键 `stage_runs.id`，删除时置空；创意阶段为空 |
| `source_revision` | 整数 | 否 | | 生成时上游记录的修订号 |
| `model_info` | 文本 | 否 | | 使用的 Copilot 模型标识（家族与版本） |
| `progress_json` | 文本（JSON） | 否 | | 进度：当前步骤、总步数、已完成数、创意大纲等，供页面显示与中断后继续 |
| `raw_output` | 文本 | 否 | | 最近一次模型原始输出，仅在失败时保留，便于排查 |
| `error_message` | 文本 | 否 | | 失败或取消原因 |
| `created_at` | 文本 | 是 | | |
| `finished_at` | 文本 | 否 | | 生成结束时间 |
| `approved_at` | 文本 | 否 | | 最近一次确认时间 |
| `applied_at` | 文本 | 否 | | 仅剧本阶段使用：结构已合并到 `episodes`、`script_entities` 的时间，空表示尚未合并 |

约束：

- 同一 `(work_id, stage, episode_id)` 下最多一条 `is_current = 1`（部分唯一索引，`episode_id` 为空时按 0 处理）。
- 同一 `(work_id, stage, episode_id)` 下最多一条 `status = running`（部分唯一索引），避免同时生成。
- CHECK：`is_current = 0` 或（`status = succeeded` 且 `review_status = approved`）；`review_status = approved` 时 `status = succeeded`。
- `stage = storyboard_script` 时 `episode_id` 必须有值，其他阶段必须为空（CHECK）。
- `source_run_id` 与 `source_revision` 是否成对出现由业务层保证。

#### `chapters` 章节正文

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 整数 | 是 | |
| `run_id` | 整数 | 是 | 外键 `stage_runs.id`，级联删除 |
| `seq` | 整数 | 是 | 章节序号，从 1 开始，上限 100 |
| `title` | 文本 | 是 | |
| `content` | 文本 | 是 | 正文 |
| `created_at` | 文本 | 是 | |

约束：`(run_id, seq)` 唯一。

### 4.2 剧本、集与脚本实体

#### `screenplays` 剧本包

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 整数 | 是 | |
| `run_id` | 整数 | 是 | 外键 `stage_runs.id`，级联删除，唯一 |
| `title` | 文本 | 是 | 作品标题 |
| `overview` | 文本 | 是 | 作品信息与改编梗概 |
| `full_text` | 文本 | 是 | 完整剧本包正文，用户可编辑，原地更新 |
| `structure_json` | 文本（JSON） | 是 | 从正文抽取的集和实体，见下方说明；确认采用前只存在这里，确认时合并到 `episodes`、`script_entities` |
| `updated_at` | 文本 | 是 | |

#### `episodes` 集

单个短视频也建 1 条，下游不区分单集与多集。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `work_id` | 整数 | 是 | | 外键 `works.id`，级联删除 |
| `seq` | 整数 | 是 | | 集序号，从 1 开始 |
| `title` | 文本 | 是 | | 集标题 |
| `synopsis` | 文本 | 是 | 空串 | 本集梗概 |
| `screenplay_text` | 文本 | 是 | 空串 | 本集剧本正文 |
| `target_duration_seconds` | 整数 | 否 | | 本集目标时长 |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：`(work_id, seq)` 唯一。集的进度状态（未配置、待绑定、可生成、生成中、部分完成、已完成）由绑定和镜头任务实时汇总，不存库。

#### `script_entities` 脚本实体

由剧本的设定清单产生，属于整个作品，在各集之间共用。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | 脚本和镜头通过它引用实体，改名不断链 |
| `work_id` | 整数 | 是 | | 外键 `works.id`，级联删除 |
| `kind` | 文本 | 是 | | `character`、`scene`、`prop`、`effect` |
| `name` | 文本 | 是 | | 稳定名称 |
| `aliases_json` | 文本（JSON） | 是 | `[]` | 别名列表 |
| `description` | 文本 | 是 | 空串 | 设定摘要 |
| `attributes_json` | 文本（JSON） | 是 | `{}` | 按类型区分的设定，见 4.5 |
| `is_active` | 整数 | 是 | 1 | 重新生成剧本后不再出现的实体置 0，不删除 |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：`(work_id, kind, name)` 唯一。

### 4.3 分镜脚本与镜头

#### `storyboard_scripts` 分镜脚本

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 整数 | 是 | |
| `episode_id` | 整数 | 是 | 外键 `episodes.id`，级联删除 |
| `run_id` | 整数 | 是 | 外键 `stage_runs.id`，级联删除，唯一 |
| `created_at` | 文本 | 是 | |

说明：分镜脚本、镜头、出场实体和声音在生成成功时由一次事务整份写入（重试会覆盖该阶段记录原有的分镜脚本）；它们直接引用 `script_entities.id`，没有“合并”步骤，确认采用只改 `stage_runs` 的确认状态。阶段记录的 `input_json` 保存 `{ workName, projectStyle, params }`，`params` 为规范化后的生成参数（画面风格、单镜头时长范围、镜头总数上限、连贯策略、声音模式与声音内容、补充要求）。用户编辑镜头时，出场实体与声音整体替换，镜头序号不变。

#### `shots` 镜头

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `storyboard_script_id` | 整数 | 是 | | 外键 `storyboard_scripts.id`，级联删除 |
| `seq` | 整数 | 是 | | 集内镜头序号，从 1 开始 |
| `scene_label` | 文本 | 是 | 空串 | 所属场次，如“第01场” |
| `shot_size` | 文本 | 是 | 空串 | 景别，如远景、中景、特写 |
| `camera_angle` | 文本 | 是 | 空串 | 机位与视角 |
| `action` | 文本 | 是 | | 画面与主体动作 |
| `camera_movement` | 文本 | 是 | 空串 | 摄影机运动 |
| `duration_seconds` | 实数 | 是 | | 请求时长，初始取脚本建议值，可在工作台调整 |
| `transition` | 文本 | 是 | 空串 | 转场 |
| `continuity_note` | 文本 | 是 | 空串 | 连续性要求 |
| `first_frame_mode` | 文本 | 是 | `none` | `none`、`prev_tail`、`asset` |
| `first_frame_asset_file_id` | 整数 | 否 | | `asset` 模式下的首帧图，外键 `asset_files.id`，删除时置空 |
| `group_id` | 整数 | 否 | | 所属镜头组，外键 `shot_groups.id`，组被删除时置空；空表示尚未分组（新增镜头、旧数据），读取时自动补全 |
| `prompt_zh` | 文本 | 是 | 空串 | 中文视频提示词 |
| `prompt_en` | 文本 | 是 | 空串 | 英文视频提示词 |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：

- `(storyboard_script_id, seq)` 唯一。
- 对白、旁白、音效、配乐不在镜头表中，由 `shot_sounds` 保存。
- `first_frame_mode = 'asset'` 时 `first_frame_asset_file_id` 必须有值，由业务层校验；不做数据库 CHECK，因为删除资产文件时该列会被置空。
- `first_frame_mode = 'prev_tail'` 时该镜头不能是集内的第 1 个镜头（由业务校验，不做 CHECK）。

#### `shot_groups` 镜头组

平台按“生成次数”计费，不论视频多短都算一次，且多参考图生成不能同时用首尾帧。因此把序号相邻的镜头打包成组，一组一次生成一个多镜头视频（组内自然连贯，不需要首尾帧衔接），生成任务、结果视频都挂在组上。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `storyboard_script_id` | 整数 | 是 | | 外键 `storyboard_scripts.id`，级联删除 |
| `seq` | 整数 | 是 | | 组序号，从 1 开始 |
| `created_at` | 文本 | 是 | | |

约束与规则：

- `(storyboard_script_id, seq)` 唯一；组的成员由 `shots.group_id` 表示，组内镜头序号连续。
- **单组最长时长**：生成分镜脚本时设定（默认 15 秒，2 至 120 的整数，保存在阶段记录 `input_json.params.groupMaxSeconds`），应不超过目标视频模型单次最长时长（15、20、30 秒…）。单个镜头时长不能超过它。
- **自动分组**：生成成功后、新增或删除镜头后、读取时发现有未分组镜头时，保留已有的组，把未分组的镜头按顺序补在最后：先并入最后一组（放得下时），否则新开一组；空组自动删除。打包按顺序装满一组再开下一组；超限时若是在同一场次中间断开，且退回到场次变化处后前面的部分不少于上限的一半、退回的部分加上新镜头仍放得下，就退回。
- **手动调整**（生成工作台）：“重新分组”（可指定新的每组最长时长，丢弃全部旧组和它们的生成记录）、“从某镜头前拆开”、“并入上一组”。拆分和合并只允许在没有任何生成记录的组上进行；重新分组在有进行中的任务时被拒绝。
- 重新生成分镜脚本会产生新的阶段记录与分镜脚本，旧版本的组和记录随旧版本保留。

#### `shot_entities` 镜头出场实体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `shot_id` | 整数 | 是 | 外键 `shots.id`，级联删除 |
| `entity_id` | 整数 | 是 | 外键 `script_entities.id`，级联删除 |

主键：`(shot_id, entity_id)`。

#### `shot_sounds` 镜头声音

一个镜头可有多条声音条目，按顺序排列。提交时，启用的条目会被编译为声音提示词，交给支持原生声音的模型。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `shot_id` | 整数 | 是 | | 外键 `shots.id`，级联删除 |
| `seq` | 整数 | 是 | | 镜头内顺序，从 1 开始 |
| `kind` | 文本 | 是 | | `dialogue` 角色对白、`narration` 旁白、`sfx` 音效、`music` 背景音乐 |
| `speaker_entity_id` | 整数 | 否 | | 说话人，仅 `dialogue` 使用，外键 `script_entities.id`，删除时置空 |
| `text` | 文本 | 是 | | 对白或旁白的台词；音效、配乐的描述 |
| `delivery` | 文本 | 是 | 空串 | 说话方式或声音质感，如“低声、急促”“清脆的玻璃破碎声”“紧张的弦乐” |
| `start_offset_seconds` | 实数 | 否 | | 相对镜头起点的开始时间，空表示由模型自行安排 |
| `duration_seconds` | 实数 | 否 | | 持续时长，空表示由模型自行安排 |
| `audio_asset_id` | 整数 | 否 | | 指定使用的音频资产（现成配乐、音效、音色参考），外键 `assets.id`，删除时置空 |
| `is_enabled` | 整数 | 是 | 1 | 是否参与提交，用于临时关掉某条声音 |

约束：

- `(shot_id, seq)` 唯一。
- `kind = 'dialogue'` 时 `speaker_entity_id` 必须有值且为角色类实体；其他类型时为空（业务校验）。
- `audio_asset_id` 指向的资产必须是音频类型，且与条目类型匹配：`music` 对应配乐，`sfx` 对应音效，`dialogue`、`narration` 对应音色参考（业务校验）。

### 4.4 资产与绑定

#### `assets` 资产

资产不属于项目（迁移 010 去掉了 `project_id`），所有项目共用，可在多个作品、多集中复用，相同的角色、场景不必在每个项目里重复创建和生成。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `kind` | 文本 | 是 | | `character`、`scene`、`prop`、`effect`、`audio` |
| `name` | 文本 | 是 | | 资产名称 |
| `source_entity_id` | 整数 | 否 | | 由哪个脚本实体创建，外键 `script_entities.id`，删除时置空 |
| `category_id` | 整数 | 否 | | 所属分类，外键 `asset_categories.id`，分类被删除时置空；空表示不分类（迁移 013 新增，已有资产全部不分类） |
| `attributes_json` | 文本（JSON） | 是 | `{}` | 按类型区分的描述字段，见 4.5 |
| `composition` | 文本 | 是 | 空串 | 视角与构图 |
| `style` | 文本 | 否 | | 画面风格；为空表示不指定风格 |
| `background` | 文本 | 是 | 空串 | 背景 |
| `reference_aspect_ratio` | 文本 | 否 | | 参考图画幅，仅表示参考图尺寸比例 |
| `extra_requirements` | 文本 | 是 | 空串 | 补充要求 |
| `prompt_zh` | 文本 | 是 | 空串 | 中文图像生成提示词 |
| `prompt_en` | 文本 | 是 | 空串 | 英文图像生成提示词 |
| `content_revision` | 整数 | 是 | 1 | 表单内容修订号，见 4.9（迁移 009 新增） |
| `prompt_revision` | 整数 | 是 | 0 | 提示词修订号，0 表示还没有提示词（迁移 009 新增） |
| `prompt_content_revision` | 整数 | 是 | 0 | 当前提示词依据的 `content_revision`（迁移 009 新增） |
| `prompt_status` | 文本 | 是 | `none` | 提示词后台生成的状态：`none`、`running`、`succeeded`、`failed`、`canceled`（迁移 009 新增） |
| `prompt_error` | 文本 | 否 | | 提示词生成失败或被中断的原因（迁移 009 新增） |
| `adopted_version_id` | 整数 | 否 | | 当前采用的生成版本，外键 `asset_versions.id`，删除时置空（迁移 009 新增） |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：`(kind, name)` 全局唯一。所属分类必须与资产同类型（业务校验：表单只提供同类型的分类，提交时按（类型，名称）解析）；分类不影响 `content_revision` 与提示词状态，改分类不会让提示词变为“需更新”。

音频类型的资产不使用 `composition`、`style`、`background`、`reference_aspect_ratio`，这些字段保持空；它的描述字段见 4.5。提示词字段在音频资产里用作“音频生成提示词”。

#### `asset_categories` 资产分类

分类属于某个资产类型（角色分类只用于角色，场景分类只用于场景），资产可以归入一个分类，也可以不分类。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `kind` | 文本 | 是 | | `character`、`scene`、`prop`、`effect`、`audio`，创建后不能修改 |
| `name` | 文本 | 是 | | 分类名称，最多 30 字 |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

约束：`(kind, name)` 唯一；列表按创建顺序（`id`）排列。删除分类时，归入该分类的资产自动变为不分类（`assets.category_id` 置空），资产本身保留。

#### `asset_files` 资产图片

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `asset_id` | 整数 | 是 | | 外键 `assets.id`，级联删除 |
| `role` | 文本 | 是 | `reference` | `reference` 参考图或参考音频、`thumbnail` 缩略图；音频资产只用 `reference` |
| `file_name` | 文本 | 是 | | |
| `mime` | 文本 | 是 | | 图片仅允许 `image/png`、`image/jpeg`、`image/webp`；音频仅允许 `audio/mpeg`、`audio/wav`、`audio/mp4` |
| `width` | 整数 | 否 | | 图片像素宽，音频为空 |
| `height` | 整数 | 否 | | 图片像素高，音频为空 |
| `duration_seconds` | 实数 | 否 | | 音频时长，图片为空 |
| `size_bytes` | 整数 | 是 | | |
| `content` | 二进制 | 是 | | 图片或音频内容 |
| `sort_order` | 整数 | 是 | 0 | 同一资产内的顺序 |
| `created_at` | 文本 | 是 | | |

列表查询只读取缩略图，不读取参考图的 `content`。

实现约定：图片资产的每张参考图对应一条 `role = thumbnail` 的缩略图记录（`sort_order` 与参考图一致，由页面用 canvas 生成 256px 的 JPEG，随表单提交）；列表取 `sort_order` 最小的一条。资产编辑时文件整体替换（先删后写），采用资产版本时同样整体替换（见 4.9）；表单里手动改动了文件时，`assets.adopted_version_id` 置空。音频资产没有缩略图，`duration_seconds` 由页面解码读取。

#### `entity_bindings` 实体与资产绑定

绑定属于集：同一实体在不同集可以绑定不同资产（例如不同造型）。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `episode_id` | 整数 | 是 | | 外键 `episodes.id`，级联删除 |
| `entity_id` | 整数 | 是 | | 外键 `script_entities.id`，级联删除 |
| `asset_id` | 整数 | 是 | | 外键 `assets.id`，级联删除 |
| `purpose` | 文本 | 是 | `visual` | `visual` 形象绑定、`voice` 音色绑定（仅角色实体可用） |
| `is_primary` | 整数 | 是 | 1 | 是否为该实体在本集、该用途下的主资产 |
| `note` | 文本 | 是 | 空串 | 备注，如“雨天造型” |
| `created_at` | 文本 | 是 | | |

约束：

- `(episode_id, entity_id, asset_id)` 唯一。
- 同一 `(episode_id, entity_id, purpose)` 下最多一条 `is_primary = 1`（部分唯一索引）。
- `purpose = 'visual'` 时，资产的类型必须与实体的类型一致；`purpose = 'voice'` 时，实体必须是角色，资产必须是音频类型且 `audio_kind = 'voice'`（业务校验）。

### 4.5 按类型区分的 JSON 内容

**`script_entities.attributes_json`**

| 类型 | 键 |
|---|---|
| `character` | `identity` 身份与目标、`relations` 主要关系、`appearance` 稳定外观、`outfit` 服装或状态、`voice` 音色设定 |
| `scene` | `interior_exterior` 内外景、`layout` 布局与出入口、`fixtures` 固定陈设、`time_light` 时间与光线 |
| `prop` | `appearance` 外观、`usage` 用途、`states` 初始与变化状态 |
| `effect` | `trigger` 来源或触发条件、`appearance` 视觉表现、`targets` 影响对象、`changes` 变化过程 |

**`assets.attributes_json`**

| 类型 | 键 |
|---|---|
| `character` | `character_type` 角色类型、`appearance` 角色外观、`clothing` 装束、`expression_pose` 神态与姿态、`voice_description` 音色描述 |
| `scene` | `place_type` 地点类型、`layout` 空间布局、`environment` 环境与光线 |
| `prop` | `appearance` 外观特征、`state` 当前状态 |
| `effect` | `source` 特效来源、`appearance` 视觉表现、`motion` 触发与变化、`environment_interaction` 环境交互 |
| `audio` | `audio_kind` 音频类型（`voice` 音色参考、`music` 配乐、`sfx` 音效）、`description` 风格、情绪或适用场景、`language` 语言（仅音色参考） |

### 4.6 模型与生成参数

#### `providers` 模型服务商

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `code` | 文本 | 是 | | 唯一标识，如 `wanxiang` |
| `display_name` | 文本 | 是 | | 显示名称 |
| `settings_json` | 文本（JSON） | 是 | `{}` | 非机密设置，如地域、接口地址；**不含密钥** |
| `is_enabled` | 整数 | 是 | 1 | 是否启用 |
| `created_at` | 文本 | 是 | | |
| `updated_at` | 文本 | 是 | | |

#### `models` 模型

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `provider_id` | 整数 | 是 | | 外键 `providers.id`，级联删除 |
| `code` | 文本 | 是 | | 服务商侧的模型标识 |
| `display_name` | 文本 | 是 | | |
| `is_enabled` | 整数 | 是 | 1 | 是否可选 |
| `kind` | 文本 | 是 | `video` | 模型类型：`image` 图像、`audio` 音频、`video` 视频；同一服务商可以有多种类型的模型 |
| `created_at` | 文本 | 是 | | |

约束：`(provider_id, code)` 唯一（同一服务商内模型代码不重复，不区分类型）。被生成任务或参数引用的模型只能停用，不能删除（外键限制删除）。

#### `model_capabilities` 模型能力

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model_id` | 整数 | 是 | 主键，外键 `models.id`，级联删除 |
| `capability_json` | 文本（JSON） | 是 | 能力描述，键见下表 |
| `updated_at` | 文本 | 是 | |

`capability_json` 的键按模型类型区分，未列出的键对该类型不适用。

**视频模型（`kind = video`）**

| 键 | 含义 |
|---|---|
| `aspect_ratios` | 支持的画幅列表 |
| `resolutions` | 支持的分辨率列表 |
| `duration` | 时长范围或可选值：`min`、`max`、`step`，或 `options`；`allow_auto` 为真表示支持由模型自动决定时长（请求中用 -1 表示） |
| `fps` | 支持的帧率列表 |
| `audio_modes` | 支持的声音模式：`none`、`native`（模型原生生成） |
| `audio_elements` | 原生支持的声音内容：`dialogue`、`narration`、`sfx`、`music` |
| `voice_reference` | 是否支持音色参考音频输入 |
| `audio_input_max` | 参考音频限制：`count` 数量上限、`max_seconds` 时长上限；不支持参考音频时为 null |
| `first_frame` | 是否支持首帧输入 |
| `last_frame` | 是否支持尾帧输入 |
| `reference_images_max` | 参考图数量上限；0 表示不支持参考图 |
| `seed` | 是否支持随机种子 |
| `prompt_languages` | 提示词语言：`zh`、`en` |
| `prompt_max_length` | 提示词长度上限 |

**图像模型（`kind = image`）**

| 键 | 含义 |
|---|---|
| `aspect_ratios` | 支持的画幅列表 |
| `resolutions` | 支持的尺寸或分辨率列表 |
| `images_per_request_max` | 单次请求最多生成的图片数 |
| `reference_images_max` | 参考图数量上限 |
| `seed` | 是否支持随机种子 |
| `prompt_languages` | 提示词语言：`zh`、`en` |
| `prompt_max_length` | 提示词长度上限 |

**音频模型（`kind = audio`）**

| 键 | 含义 |
|---|---|
| `audio_kinds` | 支持生成的类型：`voice` 音色参考、`music` 配乐、`sfx` 音效 |
| `duration` | 时长范围：`min`、`max` |
| `languages` | 支持的语言（仅音色） |
| `voices` | 可选的预置音色列表 |
| `reference_audio` | 是否支持参考音频输入 |
| `prompt_languages`、`prompt_max_length` | 同上 |

能力描述由适配器（代码）声明，扩展激活时同步到本表；入库的 JSON 使用 snake_case 键，领域对象中为 camelCase，由仓库转换（`domain/rules/model-capability-rules.ts`）。服务商的非机密设置（如接口地址）保存在 `providers.settings_json`，键由适配器声明的设置项决定。

#### `generation_profiles` 生成参数

每个作品、集、镜头组最多一条，字段为空表示沿用上一级。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 整数 | 是 | |
| `scope` | 文本 | 是 | `work`、`episode`、`group`（迁移 011 起；视频按镜头组生成，原来的镜头级 `shot` 从未写入，已去掉） |
| `work_id` | 整数 | 否 | `scope = work` 时必填，外键 `works.id`，级联删除 |
| `episode_id` | 整数 | 否 | `scope = episode` 时必填，外键 `episodes.id`，级联删除 |
| `group_id` | 整数 | 否 | `scope = group` 时必填，外键 `shot_groups.id`，级联删除（重新分组丢弃镜头组时，它的覆盖随之清除） |
| `model_id` | 整数 | 否 | 外键 `models.id`，限制删除 |
| `aspect_ratio` | 文本 | 否 | 画幅 |
| `resolution` | 文本 | 否 | 分辨率 |
| `min_shot_seconds` | 实数 | 否 | 单镜头最短时长，仅作品级使用 |
| `max_shot_seconds` | 实数 | 否 | 单镜头最长时长，仅作品级使用 |
| `audio_mode` | 文本 | 否 | `none` 无声、`native` 模型原生生成、`external` 独立音轨（预留，本阶段不可选） |
| `audio_elements_json` | 文本（JSON） | 否 | 启用的声音内容，数组，元素为 `dialogue`、`narration`、`sfx`、`music`，按这个顺序去重保存、至少一项；仅 `audio_mode` 为 `native` 时有意义；为空表示模型支持的全部（已实现，工作台参数页签读写） |
| `seed` | 整数 | 否 | 随机种子，0 至 2147483647；为空表示随机，不传给模型；仅模型能力声明支持种子时可用（已实现，工作台参数页签读写） |
| `duration_seconds` | 实数 | 否 | 本组生成时长（秒），迁移 012 新增，大于 0，**仅 `scope = group` 使用**（作品、集不保存）：整组视频的时长；为空表示按组内镜头总时长向上对齐到模型支持的取值 |
| `extra_params_json` | 文本（JSON） | 是 | 模型专有参数，默认 `{}` |
| `updated_at` | 文本 | 是 | |

约束：

- `work_id`、`episode_id`、`group_id` 三者中有且仅有一个非空，且与 `scope` 一致（CHECK）。
- 每个目标最多一条：`work_id`、`episode_id`、`group_id` 各建一个部分唯一索引。
- `duration_seconds` 为空或大于 0（CHECK）；只能在镜头组范围保存，由规则层在保存时拒绝作品、集范围的写入。

**参数合并规则**：对每个参数，依次取镜头组、集、作品的值，取第一个非空值；画幅和分辨率最后回退到项目默认值。种子为空表示随机（不传），声音内容为空表示模型支持的全部；`duration_seconds` 只取镜头组的值。提交时按每组自己合并后的参数校验：种子要求模型能力声明支持；指定的生成时长不得小于组内镜头总时长，并须落在模型能力的时长范围内（`min`、`max`、`step` 或 `options`）；模型不支持的声音内容在提交预览中列出并忽略。单镜头时长仍以 `shots.duration_seconds` 为准（在分镜脚本阶段编辑），“单镜头时长范围”目前保存在分镜脚本阶段记录的输入快照中，本表的 `min_shot_seconds`、`max_shot_seconds` 暂未写入。

### 4.7 生成任务与结果

#### `video_jobs` 镜头组生成任务

每次提交一个镜头组产生一条记录，对应一次平台生成（一个多镜头视频）；重试产生新记录。任务只在提交时创建，“草稿”“就绪”是校验阶段的界面状态，不入库。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `group_id` | 整数 | 是 | | 外键 `shot_groups.id`，级联删除 |
| `model_id` | 整数 | 是 | | 外键 `models.id`，限制删除 |
| `status` | 文本 | 是 | | `waiting`、`queued`、`running`、`succeeded`、`failed`、`canceled` |
| `request_snapshot_json` | 文本（JSON） | 是 | | 提交时的完整请求快照，见下表 |
| `remote_job_id` | 文本 | 否 | | 模型服务侧的任务标识 |
| `error_category` | 文本 | 否 | | 仅 `failed` 时有值：`auth`（密钥或账号）、`rate_limited`（限流）、`invalid_request`（参数）、`content_rejected`（内容审核未通过）、`server`（服务端）、`network`（网络），与 `ProviderError` 的分类一致 |
| `error_code` | 文本 | 否 | | 服务商返回的错误码，如 `DataInspectionFailed` |
| `error_message` | 文本 | 否 | | 服务商返回的原始说明，原样保存并显示给用户，用于判断如何修改后再次生成 |
| `attempt` | 整数 | 是 | 1 | 同一镜头组的第几次提交 |
| `prev_job_id` | 整数 | 否 | | 依赖的前序镜头任务，外键 `video_jobs.id`，删除时置空 |
| `first_frame_id` | 整数 | 否 | | 作为首帧的尾帧，外键 `result_frames.id`，删除时置空 |
| `created_at` | 文本 | 是 | | |
| `submitted_at` | 文本 | 否 | | 实际提交给模型的时间 |
| `finished_at` | 文本 | 否 | | |

`request_snapshot_json` 的键（JSON 内使用 camelCase；当前实现，首帧不进快照而是记录在任务的 `prev_job_id`、`first_frame_id`，独立音轨以后再增加键）：

| 键 | 含义 |
|---|---|
| `providerCode`、`modelCode` | 服务商与模型标识 |
| `shotIds` | 本次生成包含的镜头（组内全部），按序号排列 |
| `params` | 合并后的最终参数：`aspectRatio`、`resolution`、`durationSeconds`（组总时长，按模型能力向上对齐；本组指定了生成时长时取指定值）、`audioMode`、`audioElements`（实际编译进提示词的声音内容，已去掉模型不支持的项；声音模式不是原生生成时为 `null`；早期版本提交的快照没有这个键）、`seed`、`extraParams` |
| `prompt` | 编译后的提示词：参考图编号说明开头；多镜头时每个镜头写成“(开始 - 结束) 镜头提示词 声音：…”的时间段（如 `(0:00 - 0:04)`），单镜头不加时间段 |
| `referenceImageFileIds` | 组内出场实体（去重）使用的资产图片文件 ID 列表（只存引用，提交给服务商前才读取内容） |
| `referenceAudioFileIds` | 使用的资产音频文件 ID 列表（含角色音色参考） |
| `storyboardRunId` | 使用的分镜脚本版本 |
| `warnings` | 提交时的提醒，如“使用上一组尾帧作首帧，未传参考素材”“某实体没有绑定资产” |

快照中不得出现密钥。

#### `video_results` 结果视频

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `job_id` | 整数 | 是 | | 外键 `video_jobs.id`，级联删除 |
| `group_id` | 整数 | 是 | | 冗余保存，便于按镜头组查询，外键 `shot_groups.id`，级联删除 |
| `file_path` | 文本 | 是 | | 相对扩展存储目录的路径 |
| `remote_url` | 文本 | 否 | | 服务商返回的临时地址；地址带签名且约 24 小时失效，当前不保存，结果在完成时就下载到本地 |
| `remote_expires_at` | 文本 | 否 | | 临时地址过期时间 |
| `duration_seconds` | 实数 | 否 | | 实际时长；服务商没有返回时为空 |
| `width` | 整数 | 否 | | 服务商没有返回时为空 |
| `height` | 整数 | 否 | | 服务商没有返回时为空 |
| `size_bytes` | 整数 | 是 | | |
| `has_audio` | 整数 | 是 | 0 | 结果视频是否带声音轨 |
| `is_selected` | 整数 | 是 | 0 | 是否为该镜头采用的版本 |
| `created_at` | 文本 | 是 | | |

约束：同一 `group_id` 下最多一条 `is_selected = 1`（部分唯一索引）。第一个成功的结果自动采用，切换采用版本时在一个事务里先取消原来的、再设置新的。

视频文件路径规则：`videos/{project_id}/{work_id}/{episode_id}/{group_id}-{job_id}.mp4`。

#### `result_frames` 尾帧图片

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `result_id` | 整数 | 是 | | 外键 `video_results.id`，级联删除 |
| `kind` | 文本 | 是 | `tail` | 目前只有 `tail` |
| `mime` | 文本 | 是 | | |
| `width` | 整数 | 是 | | |
| `height` | 整数 | 是 | | |
| `content` | 二进制 | 是 | | 图片内容 |
| `created_at` | 文本 | 是 | | |

### 4.8 独立音轨（预留）

用于“声音与视频分开生成、再合成”的方式。**本阶段只设计结构，不开发功能，也不建表**；开发时新增迁移 `014-audio-tracks`（011 已用于镜头组参数，012 已用于生成参数的生成时长，013 已用于资产分类）。

#### `episode_audio_tracks` 集的独立音轨

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `episode_id` | 整数 | 是 | | 外键 `episodes.id`，级联删除 |
| `kind` | 文本 | 是 | | `dialogue`、`narration`、`sfx`、`music`、`mix`（混合后的完整音轨） |
| `source` | 文本 | 是 | | `generated` 生成、`asset` 来自资产 |
| `audio_asset_id` | 整数 | 否 | | `source = asset` 时必填，外键 `assets.id`，删除时置空 |
| `file_path` | 文本 | 否 | | 生成结果文件的相对路径 |
| `start_seconds` | 实数 | 是 | 0 | 在本集时间轴上的起始时间 |
| `duration_seconds` | 实数 | 否 | | 时长 |
| `volume` | 实数 | 是 | 1.0 | 音量倍数 |
| `sort_order` | 整数 | 是 | 0 | 同一时间点上的排列 |
| `created_at` | 文本 | 是 | | |

### 4.9 资产生成版本（图像、音频模型）

资产的“提示词”和“图片/音频”是两步，流程见 [ARCHITECTURE.md](ARCHITECTURE.md) 6.7：

- **提示词**由 Copilot 在后台生成，状态与结果保存在 `assets` 上（`prompt_status`、`prompt_zh`、`prompt_en`），不做版本管理，用户可随时手动修改。
- **图片或音频**由图像、音频模型生成，**每次提交产生一个版本**（`asset_versions`），所有历史版本都保存，用户从中采用最终版本；采用的版本才写入 `asset_files`，被绑定和视频生成使用。

迁移 `009-asset-generation`（步骤 11）创建下面两张表，并给 `assets` 增加 4.4 中标注“迁移 009 新增”的字段。

#### `asset_versions` 资产生成版本

一行既是版本，也是生成任务：每次提交新建一行，版本号加 1；失败或已取消的版本可在原行上“重试”（`attempt` 加 1，版本号不变），“重新生成”则新建版本。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `asset_id` | 整数 | 是 | | 外键 `assets.id`，级联删除 |
| `version` | 整数 | 是 | | 同一资产内的版本号，从 1 开始，只在提交生成时加 1 |
| `model_id` | 整数 | 是 | | 外键 `models.id`，限制删除；模型类型必须是 `image` 或 `audio`（业务校验） |
| `status` | 文本 | 是 | | `queued`、`running`、`succeeded`、`failed`、`canceled` |
| `request_snapshot_json` | 文本（JSON） | 是 | | 提交时的请求快照，键见下表；不得出现密钥 |
| `content_revision` | 整数 | 是 | | 提交时资产的 `content_revision` |
| `prompt_revision` | 整数 | 是 | | 提交时资产的 `prompt_revision` |
| `remote_job_id` | 文本 | 否 | | 模型服务侧任务标识 |
| `error_category`、`error_code`、`error_message` | 文本 | 否 | | 仅 `failed` 时有值，含义与 `video_jobs` 相同 |
| `attempt` | 整数 | 是 | 1 | 同一版本的第几次尝试 |
| `created_at`、`submitted_at`、`finished_at` | 文本 | | | 时间 |

约束：`(asset_id, version)` 唯一；同一资产同时只能有一个 `queued` 或 `running` 的版本（部分唯一索引）。

`request_snapshot_json` 的键（camelCase）：

| 键 | 含义 |
|---|---|
| `providerCode`、`modelCode` | 服务商与模型标识 |
| `promptLanguage` | 实际发送的提示词语言：`zh` 或 `en` |
| `promptZh`、`promptEn` | 提交时的两份提示词全文（提示词不做版本管理，快照只用于说明与复现） |
| `params` | 生成参数：`count`（图片数量，音频固定为 1）、`aspectRatio`、`resolution`、`seed`、`extraParams`；音频另有模型声明的参数（如预置音色，随音频模型确定） |
| `referenceCount` | 作为参考输入的参考图数量，没有使用时为 0 |
| `warnings` | 提交时的提醒 |

#### `asset_version_files` 版本结果文件

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | 整数 | 是 | 自增 | |
| `version_id` | 整数 | 是 | | 外键 `asset_versions.id`，级联删除 |
| `role` | 文本 | 是 | `result` | `result` 结果图片或音频、`thumbnail` 缩略图 |
| `file_name` | 文本 | 是 | | |
| `mime` | 文本 | 是 | | 与 `asset_files` 相同的允许范围 |
| `width`、`height` | 整数 | 否 | | 图片像素，音频为空 |
| `duration_seconds` | 实数 | 否 | | 音频时长 |
| `size_bytes` | 整数 | 是 | | |
| `content` | 二进制 | 是 | | 内容 |
| `sort_order` | 整数 | 是 | 0 | 同一版本内的顺序；缩略图与对应结果的 `sort_order` 一致 |
| `is_adopted` | 整数 | 是 | 0 | 该结果文件是否已被采用到 `asset_files` |
| `created_at` | 文本 | 是 | | |

缩略图与资产文件一样由页面用 canvas 生成（宿主不引入图像库）：版本弹出层显示某个版本时，发现缺少缩略图就生成并回传保存；列表只读缩略图。

#### 修订号与“有改动未生成”

提示词和图片的“过期”由修订号推算，不创建空版本：

| 字段 | 何时加 1 |
|---|---|
| `assets.content_revision` | 表单里影响生成的字段发生变化：描述字段、视角与构图、画风、背景、参考图画幅、补充要求（音频为类型、描述、语言、补充要求）。只改名称、只改文件不加 |
| `assets.prompt_revision` | 保存时 `prompt_zh` 或 `prompt_en` 的文本发生变化（手动修改），或后台生成提示词成功 |

- **提示词的依据**：`prompt_content_revision` 记录当前提示词依据的 `content_revision`。后台生成成功时取“生成开始时”的 `content_revision`；用户保存表单时修改了提示词，视为已确认，取保存后的 `content_revision`；只改了表单字段而没改提示词，不更新它。
- **提示词需更新**：有提示词，且 `prompt_content_revision < content_revision`。
- **图片/音频有改动未生成**：资产至少有一个版本，且最新的版本（不含已取消）满足 `content_revision < assets.content_revision` 或 `prompt_revision < assets.prompt_revision`。生成进行中修改表单或提示词，该版本完成时自然显示为有改动未生成。
- **采用版本与手动文件**：采用版本时写入 `adopted_version_id`；表单提交的文件与现有文件（名称、大小、内容）不一致时，视为手动修改，`adopted_version_id` 置空。

## 5. 索引

| 表 | 索引 | 用途 |
|---|---|---|
| `works` | `(project_id)` | 项目下的作品列表 |
| `work_sources` | `(work_id, sort_order)` | 读取素材 |
| `stage_runs` | `(work_id, stage, episode_id, version DESC)` | 查最新版本 |
| `stage_runs` | 部分唯一 `(work_id, stage, ifnull(episode_id, 0)) WHERE is_current = 1` | 保证一个当前版本 |
| `stage_runs` | 部分唯一 `(work_id, stage, ifnull(episode_id, 0)) WHERE status = 'running'` | 同一目标同时只能有一个运行中的生成 |
| `stage_runs` | `(source_run_id)` | 查找依赖某个上游记录的下游，判断过期 |
| `episodes` | `(work_id, seq)` 唯一 | 集顺序 |
| `script_entities` | `(work_id, kind, name)` 唯一 | 实体去重与匹配 |
| `shots` | `(storyboard_script_id, seq)` 唯一 | 镜头顺序 |
| `assets` | `(kind, name)` 唯一 | 资产列表与去重 |
| `assets` | `(category_id)` | 按分类统计资产数量与筛选 |
| `asset_categories` | `(kind, name)` 唯一 | 同类型内分类去重 |
| `asset_files` | `(asset_id, role, sort_order)` | 读取缩略图和参考图 |
| `asset_versions` | `(asset_id, version)` 唯一 | 版本列表与版本号 |
| `asset_versions` | `(status)` | 队列扫描、启动恢复 |
| `asset_versions` | 部分唯一 `(asset_id) WHERE status IN ('queued', 'running')` | 同一资产同时只能有一个进行中的生成 |
| `asset_version_files` | `(version_id, role, sort_order)` | 读取版本的缩略图和结果文件 |
| `entity_bindings` | `(episode_id, entity_id, asset_id)` 唯一 | 防重复绑定 |
| `entity_bindings` | 部分唯一 `(episode_id, entity_id, purpose) WHERE is_primary = 1` | 每个实体每种用途一个主资产 |
| `generation_profiles` | 部分唯一 `(work_id) WHERE scope = 'work'`；`(episode_id)`、`(group_id)` 同理 | 每个目标一条参数 |
| `video_jobs` | `(group_id, created_at DESC)` | 镜头组的提交历史 |
| `video_jobs` | `(status)` | 队列扫描、启动恢复 |
| `video_jobs` | `(prev_job_id)` | 释放后续镜头 |
| `video_results` | 部分唯一 `(group_id) WHERE is_selected = 1` | 每个镜头组一个采用版本 |
| `shot_groups` | `(storyboard_script_id, seq)` 唯一 | 组顺序 |
| `shots` | `(group_id)` | 按组查询镜头 |
| `shot_sounds` | `(shot_id, seq)` 唯一 | 镜头内声音顺序 |
| `shot_sounds` | `(speaker_entity_id)` | 按角色查看对白 |
| `episode_audio_tracks`（预留） | `(episode_id, start_seconds, sort_order)` | 按时间轴读取音轨 |

## 6. 删除规则

| 被删除对象 | 影响 |
|---|---|
| 项目 | 级联删除其作品及下属全部数据，不影响资产（仅把资产的 `source_entity_id` 置空）；界面须二次确认并列出数量 |
| 作品 | 级联删除素材、生成记录、集、实体、参数和以下全部内容 |
| 集 | 级联删除分镜脚本、镜头、绑定、参数、生成任务和结果 |
| 资产 | 级联删除图片、生成版本及版本文件和绑定；界面须先提示被哪些集使用以及版本数量；单独删除版本时，当前采用的版本不能删除（先采用其他版本），进行中的版本需先取消 |
| 资产分类 | 不删除资产，归入该分类的资产变为不分类（`category_id` 置空）；界面须先提示受影响的资产数量 |
| 脚本实体 | 级联删除绑定和镜头引用；一般用停用（`is_active = 0`）代替删除 |
| 模型 | 被引用时数据库拒绝删除，只能停用 |
| 生成结果 | 删除视频文件与记录；若该结果的尾帧被后续任务引用，后续任务的 `first_frame_id` 置空，快照保持不变 |

删除视频结果或整个层级时，需同时清理磁盘上的视频文件；数据库不负责文件删除，由应用层在事务成功后处理。

## 7. 业务规则

1. **单个短视频也有 1 集。** 创建 `kind = single` 的作品时，同时创建第 1 集。
2. **重新生成剧本时保护下游数据。**
   - 生成时只写 `screenplays`（正文与 `structure_json`），**不修改** `episodes`、`script_entities`；用户确认采用时才按下面的规则合并，并记录 `applied_at`。已合并过的记录再次确认时不重复合并。
   - 集按序号合并：已有序号的集更新标题、梗概、正文和目标时长，抽取结果里新增的序号创建新集，不删除已有集；单个短视频的抽取结果只有 1 集，标题取生成时的作品名称。
   - 合并之后，用户对集和实体的编辑直接保存在 `episodes`、`script_entities`（同时该版本回到待确认），再次确认不重复合并；合并之前的编辑保存在 `screenplays.structure_json`。
   - 实体按 `(kind, name)` 合并，保留已有绑定；不再出现的实体置 `is_active = 0`。
   - 若已有集存在分镜脚本或生成结果，须先向用户确认。
3. **镜头组依赖。** 镜头组的第一个镜头 `first_frame_mode = prev_tail`（且不是第一组）时，任务的 `prev_job_id` 指向上一组的任务：同一次提交里刚建的任务、上一组进行中的任务，或上一组已采用结果所属的任务。上一组的尾帧已入库时任务直接为 `queued` 并记下 `first_frame_id`；否则为 `waiting`，前序成功且尾帧入库后由队列转为 `queued` 并记下 `first_frame_id`。前序失败、被取消或已被删除（`prev_job_id` 置空）时，等待的任务记为 `failed`，错误码 `PreviousGroupUnavailable`；工作台截取尾帧失败时错误码为 `TailFrameUnavailable`。一个结果视频最多有一张尾帧（重复保存会替换）。
4. **采用版本。** 每个镜头的成功结果中，只有一条 `is_selected = 1`；首次成功时自动选中，之后由用户切换。
5. **启动恢复。** 扩展启动时，把遗留的 `running` 任务按 `remote_job_id` 重新查询状态；无远端标识的置为 `failed`。超过最长等待时间（提交后 60 分钟）的任务也要先查询，平台已完成则照常取回结果，仍在生成中才记为超时失败（关闭 VS Code 期间平台可能已经生成完）；平台只保留结果约 24 小时，超过后查询到“已不再保留”记为失败。遗留的 `running` 阶段记录（`stage_runs`）一律置为 `failed`，原因为“扩展重启，已中断”。
6. **提交前校验（应用层）。** 实体是否都已绑定、参数是否落在模型能力范围内、参考图数量、密钥是否已配置、`prev_tail` 是否有前序，详见架构文档。
7. **声音。**
   - 声音先按“模型原生生成”实现（`audio_mode = native`）；“独立音轨”只预留结构。
   - 提交时，把镜头中启用、且属于 `audio_elements_json` 的 `shot_sounds` 条目编译为声音提示词；对白条目带上说话人的音色设定（实体的 `voice`）。
   - 角色在本集绑定了音色参考音频（`purpose = voice`）且模型支持 `voice_reference` 时，把它作为参考音频一并提交；模型不支持时只使用文字描述，并给出警告。
   - 模型不支持的声音内容（例如不支持背景音乐）不会被提交，提交预览中需要列出。
8. **大小限制（建议值）。** 单张资产图片不超过 10 MB；单个资产音频不超过 20 MB、时长不超过 60 秒；小说原文文件不超过 5 MB；具体数值在实现时集中配置。
9. **阶段记录的确认与版本。**
   - 生成成功（`status = succeeded`）后 `review_status = pending`；用户确认采用时，在一个事务内把同一目标原来的当前版本的 `is_current` 置 0，再把本条置为 `approved`、`is_current = 1`。
   - 产出内容（章节、剧本包正文、集、实体、镜头、声音条目）每次编辑保存，对应阶段记录的 `revision` 加 1；已确认的记录同时回到 `pending` 且 `is_current = 0`。这些编辑统一经服务层保存。
   - 下游过期：下游记录的 `source_revision` 与上游记录现在的 `revision` 不同，或上游记录不再是已确认，则该下游记录显示“上游已变更”；不自动修改或删除下游数据。
   - 下游阶段只能选择已确认（`is_current = 1`）的上游记录作为输入。
10. **资产提示词不建阶段记录、不做版本管理。** Copilot 在后台生成中英文提示词，状态与结果直接保存在 `assets`（`prompt_status`、`prompt_zh`、`prompt_en`），用户可随时修改；重新生成直接覆盖。提示词的历史不保留，版本只保存当时使用的提示词快照（见 4.9）。
11. **资产修订号与“有改动未生成”。** 见 4.9：改表单内容、改提示词只修改修订号，不创建空版本；版本号只在真正提交生成时加 1。
12. **采用资产版本。** 只有成功的版本可以采用，采用时把所选的结果文件（默认全部，最多 10 张）复制为 `asset_files`（整体替换原有的参考文件和缩略图），并记录 `adopted_version_id`。绑定和视频生成只读 `asset_files`，因此未采用的版本不影响任何下游；已提交的视频任务有请求快照，采用新版本不改变它们。
13. **音频资产的文件可以暂时为空。** 音频资产可先创建、再生成或上传文件；没有文件的音频资产不能绑定为音色参考。

## 8. 迁移计划

每个迁移脚本只负责从版本 N 到 N+1，在事务中执行，失败则回滚。

| 版本 | 脚本 | 内容 | 对应实施步骤 |
|---|---|---|---|
| 1 | `001-core` | `projects`、`works`、`work_sources`、`episodes`、`stage_runs`、`chapters`、`screenplays`、`script_entities` | 已实现 |
| 2 | `002-assets` | `assets`（含音频类型）、`asset_files`、`entity_bindings` | 已实现 |
| 3 | `003-storyboard` | `storyboard_scripts`、`shots`、`shot_entities`、`shot_sounds` | 已实现 |
| 4 | `004-models` | `providers`、`models`、`model_capabilities`、`generation_profiles` | 已实现 |
| 5 | `005-generation` | `video_jobs`、`video_results`、`result_frames` | 已实现 |
| 6 | `006-text-generation` | `stage_runs` 增加“已取消”状态、确认状态、修订号、上游记录、模型、进度、原始输出（重建该表，允许丢弃现有数据）；`screenplays` 增加 `structure_json`；`models` 增加 `kind` | 已实现 |
| 7 | `007-job-failures` | 重建 `video_jobs`、`video_results`、`result_frames`：失败分类与服务商分类一致并增加 `error_code`，结果视频的时长、宽高允许为空（测试阶段丢弃旧数据） | 已实现（步骤 8） |
| 8 | `008-shot-groups` | 新增 `shot_groups`，`shots` 增加 `group_id`；重建 `video_jobs`、`video_results`、`result_frames`，任务与结果改为挂在镜头组上（测试阶段丢弃旧数据） | 已实现（步骤 8） |
| 9 | `009-asset-generation` | `assets` 增加修订号、提示词状态、采用版本字段；新增 `asset_versions`、`asset_version_files` | 已实现（步骤 11） |
| 10 | `010-global-assets` | 重建 `assets`：去掉 `project_id`，唯一约束改为 `(kind, name)`；重名资产保留最早的一个，其余在名称后加（项目名）；原来沿用项目风格的图像资产把项目风格写入 `style`；资产文件、绑定、生成版本全部保留（迁移执行器支持 `rebuildsReferencedTables`：执行期间关闭外键，结束后检查完整性） | 已实现 |
| 11 | `011-group-profiles` | 重建 `generation_profiles`：范围改为作品、集、镜头组，新增 `group_id` | 已实现 |
| 12 | `012-profile-duration` | `generation_profiles` 新增 `duration_seconds`（本组生成时长）；种子、声音内容列早已预留，无需改表 | 已实现 |
| 13 | `013-asset-categories` | 新增 `asset_categories`；`assets` 增加可空的 `category_id`（外键，删除分类时置空），已有资产全部不分类 | 已实现 |
| 14 | `014-audio-tracks` | `episode_audio_tracks`（预留，开发独立音轨时再新增） | 后续 |

拆分说明：镜头引用资产文件，因此资产在分镜之前建立；前五个迁移创建了 22 张表，迁移 8 再增加镜头组表，各功能的仓库随功能实现逐步补全。

已发布的脚本不再修改；结构变更一律新增下一个编号的脚本。测试阶段不考虑已有数据，需要重建表（例如修改 CHECK 约束）时，新增的迁移可以直接丢弃该表及其下游表的数据，不做数据搬迁；首次发布版本（0.0.1）之后不再允许，迁移 001 至 012 视为已发布。升级前先复制数据库文件作为备份。

## 9. 与架构文档的差异说明

本文对 [ARCHITECTURE.md](ARCHITECTURE.md) 中的领域模型做了细化，以本文为准：

- 表名统一为复数小写下划线，例如 `SHOT` 对应 `shots`。
- 原“任务”统一称“作品”：表 `works`、外键 `work_id`；“任务”一词只用于“生成任务”（`video_jobs`）。
- 原 `SCRIPT` 拆为剧本包 `screenplays` 与分镜脚本 `storyboard_scripts`，版本由 `stage_runs` 统一管理。
- 脚本实体属于作品，绑定属于集，新增 `episode_id`。
- `GEN_PROFILE` 由“范围 + 范围 ID + JSON 参数”改为结构化列和三个外键。
- 新增创意阶段相关表 `work_sources`、`chapters`，以及项目级默认值。
- 生成任务只入库提交后的状态；草稿、就绪是校验阶段的界面状态。
- 声音从单个模式字段拓展为结构化内容：新增 `shot_sounds`（对白、旁白、音效、配乐），镜头表不再保存对白和声音说明文本；资产新增音频类型；绑定新增用途（形象、音色）；独立音轨只预留。
- 阶段记录增加人工确认状态、修订号和上游依赖；剧本包增加结构快照，确认后才合并到集和实体；模型增加类型（图像、音频、视频），能力描述按类型区分；资产生成采用“版本”模型（`asset_versions`、`asset_version_files`），原预留的 `asset_jobs`、`asset_candidates` 合并为这两张表。
