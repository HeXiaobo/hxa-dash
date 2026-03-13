# HxA Dash

**人机团队协作面板** — HxA 系列套件之一

让人机团队的分工、状态、工作流、任务进度**可视化**和**量化**。

🌐 **线上地址**：[jessie.coco.site/hxa-dash/](https://jessie.coco.site/hxa-dash/)

---

## 核心理念

**双重价值：**
- **对人类**：工作可视化增加**安全感** — 随时看到 Agent 在做什么、做了什么、接下来做什么
- **对 Agent**：增加**信息**，实现**有效协作** — 了解团队状态，做出更好的协作决策

HxA Dash 不只是监控面板，而是人机团队共享的信息中枢。

---

## 功能模块

### 1. 团队成员卡片（HxA Card Wall）

展示所有团队成员（Human + Agent）的实时状态。

- **在线状态**：🟢 在线 / 🔴 离线（由 HxA Connect 心跳驱动，30 分钟无响应判定离线）
- **工作状态**：Busy（有进行中任务）/ Idle（在线但无任务）/ Offline
- **身份徽章**：🧑 Human / 🤖 Agent（由 `entities.json` 的 `kind` 字段决定）
- **角色与简介**：由 `entities.json` 配置，Connect API 返回的数据优先
- **任务摘要**：当前分配的 open issues 数量 + 进行中任务标题
- **健康评分**：0–100 分（见下方说明）
- **历史统计**：7 天 / 30 天已完成任务数、平均完成时长
- **协作伙伴**：最频繁协作对象

**点击卡片**可打开详情抽屉，查看：当前任务列表（可跳转 GitLab）、近期活动时间线、协作关系详情。

---

### 2. 任务看板（Task Board）

三列看板：**待办 / 进行中 / 已完成**

- 数据来源：GitLab Issues + MRs（每 5 分钟轮询）
- 支持按项目筛选
- 实时增量更新（#43 fingerprint diff，不闪屏）

---

### 3. 工作时间线（Activity Timeline）

按时间倒序展示近期活动：issue 创建/关闭、MR 提交/合并、commit、评论。

- 支持 Webhook 实时推送（GitLab System Hook）+ 轮询双驱动
- 自动去重（#37）

---

### 4. 协作关系图（Collaboration Graph）

可视化成员间协作强度（共同参与的 issues/MRs）。

- 节点大小 = 任务参与数
- 连线粗细 = 协作频率
- 支持按项目过滤
- 过滤无贡献节点（#35）

---

### 5. 协作热力矩阵（Collab Matrix）

表格形式的协作热力图，直观展示两两成员协作频率。

---

### 6. 性能趋势图（Performance Trends）

- **日活动柱状图**：每日任务完成数（过去 7 天）
- **活动热力图**：过去 4 周每日活跃度热力展示
- **按 Agent 筛选**

---

### 7. 工作量报表（Workload Report）

每个成员的生产力指标表格：

| 指标 | 说明 |
|------|------|
| Closed Issues | 统计周期内关闭的 issues 数 |
| Merged MRs | 合并的 MRs 数 |
| 柱状图 | 相对工作量可视化 |

支持导出 JSON。

---

### 8. Blocker 检测面板

自动识别团队阻塞项：

- **过期 Issues**：open 超过 7 天未更新
- **等待 Review 的 MRs**：open MR 超过 2 天未处理
- **沉默 Agent**：online 但超过 24 小时无活动

---

### 9. 行动建议面板（Action Suggestions）

基于规则引擎，自动生成团队行动建议：

| 规则 | 触发条件 | 优先级 |
|------|----------|--------|
| Rule 1 | MR 等待 review > 48h | 🔴 高 |
| Rule 2 | Issue open > 7 天无更新 | 🔴 高 |
| Rule 3 | Agent 空闲（online + 0 任务）| 🟡 中 |
| Rule 4 | Agent 过载（open tasks > 5）| 🟡 中 |
| Rule 5 | 有未分配 issue | 🟢 低 |
| Rule 6 | 空闲率 ≥ 70% + 有未分配 issue（来自利用率面板）| 🟢 低 |
| Rule 7 | 本周产出比上周下降 > 30% | 🔴 高 |
| Rule 8 | 周期时间中位数 > 48h | 🟡 中 |

最近自动重分配历史也在此面板展示。

---

### 10. 团队利用率与产出指标（Metrics Panel）

实时团队效能指标：

| 指标 | 计算方式 |
|------|----------|
| 空闲率 | 在线 agent 中 open tasks = 0 的比例 |
| 7 天 Issues 关闭数 | 近 7 天 state=closed 的 issues |
| 7 天 MR 合并数 | 近 7 天 state=merged 的 MRs |
| 周期时间中位数 | 近 30 天关闭 issues 的 (updated_at - created_at) 中位数 |
| 4 周趋势 | 每周已关闭任务数柱状图（按 ISO 周分组）|

每 5 分钟自动刷新。Rules 6/7/8 与此面板联动。

---

### 11. 自动任务重分配（Auto-Assign Engine）

当 Agent 离线 > 30 分钟且有 open issues 时，自动分配给空闲 Agent：

- 每 5 分钟检测一次
- 每次最多重分配 3 个任务
- 执行后发 HxA Connect 通知（透明可见）
- 通过 `POST /api/auto-assign/trigger` 可手动触发
- 历史记录通过 `GET /api/auto-assign/history` 查询

---

### 12. My View（个人视角 `/api/my/:name`）

Agent 专属视角 API，返回：
- 当前分配任务（assignee only）
- 我参与/创建的 MRs
- 最近事件流
- 当前在线状态与工作状态

---

## 健康评分算法

**分值：0–100**，由三个维度加权：

| 维度 | 满分 | 逻辑 |
|------|------|------|
| 活动新鲜度 | 40 | 最近活动 < 1h → 40；< 6h → 35；< 24h → 25；< 72h → 15；< 168h → 5；更早 → 0 |
| 完成率 | 30 | 已关闭任务 / 总任务（0–30 线性映射）|
| 负载均衡 | 30 | 0 任务 → 10；1–3 任务 → 30；4–5 任务 → 20；6–8 任务 → 10；>8 任务 → 5 |

---

## 数据来源

| 数据 | 来源 | 更新频率 |
|------|------|----------|
| 成员在线状态 | HxA Connect API (`/hub/agents`) | 每 30 秒心跳 |
| Issues / MRs | GitLab API (group + projects) | 每 5 分钟轮询 |
| 实时事件 | GitLab System Hook (Webhook) | 实时推送 |
| 成员身份配置 | `config/entities.json` | 手动维护 |

### 数据流

```
HxA Connect API ──→ connectFetcher ─┐
                                    ├──→ SQLite DB ──→ Express API ──→ 前端
GitLab API ────→ gitlabFetcher ────┘
GitLab Webhook ──→ /api/report/webhook ──→ SQLite DB (实时更新)
```

---

## API 端点速查

| 端点 | 说明 |
|------|------|
| `GET /api/team` | 所有成员状态（含 health score、stats）|
| `GET /api/team/summary` | 团队摘要（在线数、空闲数、健康平均分）|
| `GET /api/board` | 任务看板（issues + MRs 按状态分类）|
| `GET /api/timeline` | 活动时间线 |
| `GET /api/stats/timeline` | Agent 活动直方图 |
| `GET /api/stats/trends` | 团队生产力趋势 |
| `GET /api/stats/agents` | 每人 30 天详细统计 |
| `GET /api/stats/workload` | 工作量报表 |
| `GET /api/my/:name` | 个人视角（当前任务、活动）|
| `GET /api/blockers` | 阻塞项检测（过期 issue、等待 review MR、沉默 agent）|
| `GET /api/auto-assign/history` | 自动重分配历史 |
| `POST /api/auto-assign/trigger` | 手动触发重分配 |
| `GET /api/metrics` | 团队利用率与产出指标 |
| `GET /api/graph` | 协作关系图（支持 `?project=` 筛选）|
| `POST /api/report/webhook` | GitLab Webhook 接收端点 |

---

## 配置

### `config/sources.json`（不入库，含密钥）

```json
{
  "connect": {
    "url": "https://connect.coco.xyz",
    "org": "coco",
    "token": "bot_xxx"
  },
  "gitlab": {
    "url": "https://git.coco.xyz",
    "token": "glpat-xxx",
    "groupId": 123
  }
}
```

### `config/entities.json`（入库，无敏感信息）

定义团队成员身份映射，`sources.json` 中的 `entities` 可覆盖此配置。

字段说明：

| 字段 | 说明 |
|------|------|
| `id` | 内部 ID（唯一） |
| `display_name` | 显示名称 |
| `kind` | `"human"` 或 `"agent"`（未设置默认 `"agent"`）|
| `role` | 角色描述 |
| `bio` | 简介（Connect API 返回数据优先）|
| `identities.connect` | HxA Connect 中的用户名 |
| `identities.gitlab` | GitLab 用户名 |

---

## 本地开发

```bash
# 安装依赖
npm install

# 复制配置模板
cp config/entities.example.json config/entities.json
# 手动创建 config/sources.json（参考上方格式）

# 启动开发服务
npm start

# 访问面板
open http://localhost:3479

# 运行测试
npm test
```

---

## 部署

通过 PM2 管理，部署在 `jessie.coco.site/hxa-dash/`。

PM2 服务名：`hxa-dash`

```bash
pm2 restart hxa-dash
pm2 logs hxa-dash
```

---

## 相关文档

- [产品需求文档 PRD v1.0](docs/prd-v1.0-reshape.md)

---

## 许可

私有项目 — Codeloop Pte. Ltd.
