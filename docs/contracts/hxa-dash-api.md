# HxA Dash API 契约文档

> 版本: 基于代码库实际实现（2026-03-22）
> 基础地址: `http://<host>:3479`
> WebSocket: `ws://<host>:3479/ws`

---

## 目录

- [1. 总览](#1-总览)
  - [1.1 端点一览表](#11-端点一览表)
  - [1.2 通用约定](#12-通用约定)
  - [1.3 认证机制](#13-认证机制)
- [2. REST API](#2-rest-api)
  - [2.1 Team — 团队管理](#21-team--团队管理)
  - [2.2 Board — 任务看板](#22-board--任务看板)
  - [2.3 Timeline — 事件时间线](#23-timeline--事件时间线)
  - [2.4 Agent — Agent 详情](#24-agent--agent-详情)
  - [2.5 Stats — 统计分析](#25-stats--统计分析)
  - [2.6 Metrics — 团队指标](#26-metrics--团队指标)
  - [2.7 Report — 上报与摘要](#27-report--上报与摘要)
  - [2.8 My View — 个人视图](#28-my-view--个人视图)
  - [2.9 Live — 实时工作面板](#29-live--实时工作面板)
  - [2.10 Blockers — 阻塞检测](#210-blockers--阻塞检测)
  - [2.11 Trends — 趋势分析](#211-trends--趋势分析)
  - [2.12 Pipeline — 依赖管道](#212-pipeline--依赖管道)
  - [2.13 MR Board — MR 管道看板](#213-mr-board--mr-管道看板)
  - [2.14 Projects — 项目管理](#214-projects--项目管理)
  - [2.15 Tokens — Token 消耗估算](#215-tokens--token-消耗估算)
  - [2.16 Auto-Assign — 自动分配](#216-auto-assign--自动分配)
  - [2.17 Overview — 聚合概览](#217-overview--聚合概览)
  - [2.18 Diagnostics — 系统诊断](#218-diagnostics--系统诊断)
  - [2.19 Agent Health — Agent 系统健康](#219-agent-health--agent-系统健康)
  - [2.20 PM2 — 服务管理](#220-pm2--服务管理)
  - [2.21 System — 系统端点](#221-system--系统端点)
  - [2.22 Graph — 协作图谱](#222-graph--协作图谱)
- [3. Webhooks](#3-webhooks)
  - [3.1 HxA Connect Webhook](#31-hxa-connect-webhook)
  - [3.2 GitLab Webhook（Report 模块）](#32-gitlab-webhookreport-模块)
  - [3.3 GitLab Webhook（依赖触发模块）](#33-gitlab-webhook依赖触发模块)
- [4. WebSocket 频道](#4-websocket-频道)
- [5. 共享数据模型](#5-共享数据模型)

---

## 1. 总览

### 1.1 端点一览表

| # | 方法 | 路径 | 认证 | 说明 |
|---|------|------|------|------|
| 1 | GET | `/api/team` | 无 | 所有 Agent 列表 + 统计 |
| 2 | GET | `/api/team/:name` | 无 | 单个 Agent 详情 |
| 3 | GET | `/api/board` | 无 | 任务看板（todo/doing/done） |
| 4 | GET | `/api/timeline` | 无 | 事件时间线 |
| 5 | GET | `/api/agent/:name/stats` | 无 | Agent 个人统计 |
| 6 | GET | `/api/agent/:name/timeline` | 无 | Agent 事件时间线 |
| 7 | GET | `/api/stats/timeline` | 无 | 活动直方图 |
| 8 | GET | `/api/stats/trends` | 无 | 团队产出趋势 |
| 9 | GET | `/api/stats/agents` | 无 | 所有 Agent 统计快照 |
| 10 | GET | `/api/stats/workload` | 无 | Agent 工作量报告 |
| 11 | GET | `/api/metrics` | 无 | 团队效率指标 |
| 12 | GET | `/api/metrics/velocity` | 无 | Session 速度指标 |
| 13 | GET | `/api/metrics/estimates` | 无 | 完成时间分析 |
| 14 | POST | `/api/report` | 无 | Agent 心跳/状态上报 |
| 15 | GET | `/api/report/summary` | 无 | 团队生产力摘要 |
| 16 | GET | `/api/my/:name` | 无 | 个人待办视图 |
| 17 | GET | `/api/live` | 无 | 实时工作面板 |
| 18 | GET | `/api/blockers` | 无 | 阻塞项检测 |
| 19 | GET | `/api/trends` | 无 | 每日完成趋势 + 热力图 |
| 20 | GET | `/api/pipeline` | 无 | 依赖驱动任务管道 |
| 21 | GET | `/api/mr-board` | 无 | MR 管道看板 + 瓶颈告警 |
| 22 | GET | `/api/projects` | 无 | 所有项目聚合 |
| 23 | GET | `/api/projects/:name` | 无 | 单个项目详情 |
| 24 | GET | `/api/tokens` | 无 | Token 消耗估算 |
| 25 | POST | `/api/auto-assign/execute` | 无 | 执行 Issue 重分配 |
| 26 | POST | `/api/auto-assign/smart` | 无 | 技能感知智能分配 |
| 27 | POST | `/api/auto-assign/claim` | 无 | Agent 自认领任务 |
| 28 | GET | `/api/auto-assign/history` | 无 | 分配历史 |
| 29 | GET | `/api/auto-assign/unassigned` | 无 | 未分配 Issue + 推荐 |
| 30 | GET | `/api/auto-assign/recommend` | 无 | 推荐分配（不执行） |
| 31 | GET | `/api/overview` | 无 | 聚合概览（JSON/文本） |
| 32 | GET | `/api/diagnostics` | 无 | 系统健康诊断 |
| 33 | POST | `/api/agent-health/:name` | HEALTH_API_KEY | Agent 上报系统指标 |
| 34 | GET | `/api/agent-health` | 无 | 所有 Agent 系统健康 |
| 35 | GET | `/api/agent-health/:name` | 无 | 单个 Agent 系统健康 |
| 36 | GET | `/api/pm2/services` | 无 | PM2 服务列表 |
| 37 | POST | `/api/pm2/:service/restart` | HEALTH_API_KEY | 重启 PM2 服务 |
| 38 | GET | `/api/about` | 无 | 版本和系统信息 |
| 39 | GET | `/api/health` | 无 | 系统健康检查 |
| 40 | GET | `/api/scopes` | 无 | 管理域列表 |
| 41 | GET | `/api/graph` | 无 | 协作关系图谱 |
| 42 | GET | `/api/health-watchdog/alerts` | 无 | 健康看门狗告警 |
| 43 | POST | `/api/webhook/connect` | 无 | HxA Connect 回调 |
| 44 | POST | `/api/webhook/gitlab`（report） | GitLab secret | GitLab 群组 webhook |
| 45 | POST | `/api/webhook/gitlab`（webhook） | GitLab secret | GitLab 依赖触发 webhook |

### 1.2 通用约定

- **响应格式**: 所有端点返回 `application/json`，除 `/api/overview?format=text` 返回 `text/plain`
- **错误响应**: `{ "error": "<错误描述>" }`，HTTP 状态码对应语义（400/401/403/404/500/503）
- **时间戳**: 所有时间戳字段均为 Unix 毫秒（`Date.now()` 格式），除非特别标注
- **分页**: 通过 `limit` 查询参数控制返回数量，各端点有各自的默认值和最大值
- **请求体**: POST 端点接受 `application/json`，限制 1MB

### 1.3 认证机制

大部分端点无需认证。需要认证的端点使用以下方式之一：

| 方式 | Header | 说明 |
|------|--------|------|
| Bearer Token | `Authorization: Bearer <HEALTH_API_KEY>` | Agent Health / PM2 写操作 |
| API Key Header | `X-API-Key: <HEALTH_API_KEY>` | 同上，替代方式 |
| GitLab Secret | `X-GitLab-Token: <secret>` | GitLab webhook 验证 |

- `HEALTH_API_KEY` 通过环境变量配置，未配置时写操作返回 403（fail-closed）
- GitLab webhook secret 在 `config/sources.json` 的 `webhooks.gitlab_secret` 配置，未配置时接受所有请求

---

## 2. REST API

### 2.1 Team — 团队管理

#### GET /api/team

获取所有 Agent 的丰富数据（含任务、统计、健康评分、协作等）。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "agents": [Agent Object, ...],
  "stats": {
    "total": 5,
    "online": 3,
    "offline": 2
  }
}
```

Agent Object 详细结构见 [5.1 Agent Object](#51-agent-object)。

---

#### GET /api/team/:name

获取单个 Agent 的完整详情，包括任务列表、近7天事件、协作边。

- **认证**: 无
- **路径参数**: `name` — Agent 名称

**响应 200**:

```json
{
  "agent": {
    "name": "Boot",
    "role": "developer",
    "bio": "...",
    "tags": ["nodejs", "frontend"],
    "online": true,
    "last_seen_at": 1711100000000
  },
  "current_tasks": [Task Object, ...],
  "recent_done": [Task Object, ...],
  "events": [
    {
      "agent": "Boot",
      "action": "pushed",
      "target_title": "fix(ui): button alignment",
      "target_url": "https://git.coco.xyz/...",
      "project": "hxa-dash",
      "timestamp": 1711100000000
    }
  ],
  "collabs": [
    { "partner": "Jessie", "type": "review", "weight": 5 }
  ],
  "stats": {
    "mr_count": 12,
    "issue_count": 20,
    "open_tasks": 3,
    "closed_tasks": 15
  }
}
```

**响应 404**: `{ "error": "Agent not found" }`

---

### 2.2 Board — 任务看板

#### GET /api/board

获取任务看板数据，按 todo（未分配）/ doing（进行中）/ done（已完成）分组。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "todo": [
    {
      "id": "issue-9-142",
      "type": "issue",
      "title": "添加搜索功能",
      "state": "opened",
      "assignee": null,
      "author": "Kevin",
      "project": "hxa-dash",
      "url": "https://git.coco.xyz/...",
      "labels": ["feature", "workflow::new"],
      "estimate": "M",
      "updated_at": 1711100000000,
      "created_at": 1711000000000
    }
  ],
  "doing": [Task Object, ...],
  "done": [Task Object, ...]
}
```

**分类逻辑**:
- `todo`: `state === 'opened'` 且无 assignee
- `doing`: `state === 'opened'` 且有 assignee
- `done`: `state === 'closed'` 或 `state === 'merged'`

---

### 2.3 Timeline — 事件时间线

#### GET /api/timeline

获取全局事件时间线，按时间降序排列。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `limit` | int | 100 | 500 | 返回事件数量 |

**响应 200**:

```json
{
  "events": [Event Object, ...]
}
```

---

### 2.4 Agent — Agent 详情

#### GET /api/agent/:name/stats

获取单个 Agent 的详细统计数据：完成率、协作、活动分解。

- **认证**: 无
- **路径参数**: `name` — Agent 名称
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 30 | 90 | 回溯窗口（天） |

**响应 200**:

```json
{
  "name": "Boot",
  "online": true,
  "last_seen_at": 1711100000000,
  "days": 30,
  "tasks": {
    "open": 3,
    "closed_in_period": 15,
    "total_in_period": 18,
    "completion_rate": 83
  },
  "activity": {
    "commits": 45,
    "comments": 20,
    "mr_opened": 8,
    "mr_merged": 6,
    "issues_closed": 10,
    "total": 89
  },
  "collaboration": {
    "top_partner": { "name": "Jessie", "weight": 12 },
    "total_edges": 3
  },
  "avg_activity_gap_hours": 2.5
}
```

**响应 404**: `{ "error": "Agent not found" }`

---

#### GET /api/agent/:name/timeline

获取单个 Agent 的事件时间线。

- **认证**: 无
- **路径参数**: `name` — Agent 名称
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `limit` | int | 50 | 200 | 返回事件数量 |

**响应 200**:

```json
{
  "name": "Boot",
  "count": 50,
  "events": [
    {
      "timestamp": 1711100000000,
      "action": "pushed",
      "target_type": "commit",
      "target_title": "fix(ui): button alignment",
      "target_url": "https://git.coco.xyz/...",
      "project": "hxa-dash"
    }
  ]
}
```

**响应 404**: `{ "error": "Agent not found" }`

---

### 2.5 Stats — 统计分析

#### GET /api/stats/timeline

按时间桶聚合的活动直方图。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `agent` | string | null | — | 按 Agent 名称过滤（可选） |
| `days` | int | 7 | 1-90 | 回溯窗口（天） |
| `granularity` | string | `"day"` | `"hour"` / `"day"` | 时间粒度 |

**响应 200**:

```json
{
  "agent": null,
  "days": 7,
  "granularity": "day",
  "buckets": [
    { "label": "2026-03-15", "count": 25 }
  ]
}
```

---

#### GET /api/stats/trends

团队产出趋势（按天聚合）。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 7 | 30 | 回溯窗口（天） |

**响应 200**:

```json
{
  "days": 7,
  "buckets": [...],
  "agents": [...]
}
```

---

#### GET /api/stats/agents

所有 Agent 的30天统计快照。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "agents": [
    {
      "name": "Boot",
      "events_30d": 120,
      "commits": 45,
      "mrs": 12,
      "issues_closed": 10,
      "comments": 20
    }
  ]
}
```

---

#### GET /api/stats/workload

Agent 工作量报告：已关闭 Issue、已合并 MR、Commits、Comments。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 30 | 90 | 回溯窗口（天） |

**响应 200**:

```json
{
  "days": 30,
  "agents": [...]
}
```

---

### 2.6 Metrics — 团队指标

#### GET /api/metrics

团队效率指标面板：利用率、产出、周吞吐趋势、Agent 分解。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "team": {
    "idle_pct": 20,
    "issues_closed_7d": 8,
    "mrs_merged_7d": 5,
    "cycle_time_median_hours": 12.5,
    "weekly_closed": [
      { "week": "2026-W11", "issues_closed": 3, "mrs_merged": 2 },
      { "week": "2026-W12", "issues_closed": 5, "mrs_merged": 3 }
    ]
  },
  "agents": [
    {
      "name": "Boot",
      "status": "busy",
      "open_tasks": 3,
      "closed_7d": 4,
      "mrs_7d": 2
    }
  ]
}
```

**字段说明**:
- `idle_pct`: 在线但无 open task 的 Agent 占比（%）
- `cycle_time_median_hours`: 过去30天已关闭 Issue 的中位生命周期（小时）
- `weekly_closed`: 最近4周的吞吐趋势

---

#### GET /api/metrics/velocity

基于 Session 的团队速度指标。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 7 | 90 | 回溯窗口（天） |

**响应 200**:

```json
{
  "window_days": 7,
  "team": {
    "total_sessions": 42,
    "sessions_per_day": 6.0,
    "active_agents": 3,
    "total_events": 200
  },
  "agents": [...],
  "summary": {...},
  "estimate_map": {
    "sessions": {...},
    "minutes": {...}
  }
}
```

---

#### GET /api/metrics/estimates

Agent 完成时间分析（基于历史数据）。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 30 | 90 | 回溯窗口（天） |

**响应 200**: 返回按 Agent 分组的完成时间统计数据。

---

### 2.7 Report — 上报与摘要

#### POST /api/report

Agent 心跳/状态上报。插入一条时间线事件，并广播 `team:update`。

- **认证**: 无
- **请求体**:

```json
{
  "name": "Boot",
  "status": "coding",
  "current_task": "修复 UI 对齐问题",
  "metadata": { "branch": "fix/alignment" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | Agent 名称 |
| `status` | string | 否 | 当前状态描述 |
| `current_task` | string | 否 | 当前正在做的事情 |
| `metadata` | object | 否 | 任意附加元数据 |

**响应 200**: `{ "ok": true, "ts": 1711100000000 }`

**响应 400**: `{ "error": "name required" }`

---

#### GET /api/report/summary

团队生产力摘要报告。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `days` | int | 7 | 1-90 | 报告周期（天） |

**响应 200**:

```json
{
  "period": {
    "days": 7,
    "from": 1710500000000,
    "to": 1711100000000
  },
  "summary": {
    "total_agents": 5,
    "online_agents": 3,
    "total_open_tasks": 15,
    "active_tasks": 10,
    "completed_in_period": 8,
    "utilization_pct": 67,
    "total_events": 120,
    "bottleneck": {
      "agent": "Boot",
      "open_tasks": 5
    }
  },
  "per_agent": [
    {
      "name": "Boot",
      "online": true,
      "open_tasks": 5,
      "completed": 3
    }
  ]
}
```

---

### 2.8 My View — 个人视图

#### GET /api/my/:name

个人待办视图：自己的任务、待 review 的 MR、相关阻塞。

- **认证**: 无
- **路径参数**: `name` — Agent 名称

**响应 200**:

```json
{
  "agent": {
    "name": "Boot",
    "role": "developer",
    "online": true
  },
  "todos": [
    {
      "title": "实现搜索功能",
      "url": "https://git.coco.xyz/...",
      "project": "hxa-dash",
      "type": "issue",
      "created_at": 1711000000000
    }
  ],
  "pending_reviews": [
    {
      "title": "feat(search): add full-text search",
      "url": "https://git.coco.xyz/...",
      "project": "hxa-dash",
      "created_at": 1711050000000
    }
  ],
  "active_projects": ["hxa-dash", "hxa-link"],
  "blockers": [
    {
      "type": "issue",
      "title": "阻塞的上游任务",
      "url": "https://git.coco.xyz/...",
      "stale_hours": 72
    }
  ]
}
```

**响应 404**: `{ "error": "Team member not found" }`

**注意**: 阻塞项定义为：与自己活跃项目相同、但分配给其他人、且超过 48 小时未更新的 open task。

---

### 2.9 Live — 实时工作面板

#### GET /api/live

实时 Agent 工作状态面板，含当前任务、近期事件、活跃度。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "agents": [
    {
      "name": "Boot",
      "displayName": "Boot",
      "role": "developer",
      "online": true,
      "workStatus": "busy",
      "effectiveStatus": "working",
      "healthScore": 85,
      "currentTasks": [
        { "title": "Fix UI", "type": "issue", "url": "...", "project": "hxa-dash" }
      ],
      "recentEvents": [
        {
          "action": "pushed",
          "targetTitle": "fix alignment",
          "targetType": "commit",
          "project": "hxa-dash",
          "timestamp": 1711100000000
        }
      ],
      "lastActiveMs": 120000,
      "activityIntensity": 5,
      "activeProjects": ["hxa-dash"]
    }
  ],
  "summary": {
    "total": 5,
    "working": 2,
    "active": 1,
    "idle": 1,
    "offline": 1
  },
  "timestamp": 1711100000000
}
```

**effectiveStatus 逻辑**:
- `working`: 在线 + 有 open task 或 work_status 为 busy
- `active`: 在线 + 30 分钟内有活动事件
- `idle`: 在线但无任务且无近期活动
- `offline`: 不在线

**排序**: working > active > idle > offline

---

### 2.10 Blockers — 阻塞检测

#### GET /api/blockers

检测项目阻塞：停滞 Issue、无人 Review MR、停滞 MR、失联 Agent。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `threshold_issue_h` | int | 72 | Issue 停滞阈值（小时） |
| `threshold_mr_h` | int | 24 | MR 无人 review 阈值（小时） |
| `threshold_stale_mr_h` | float | 0.5 | MR 停滞阈值（小时，即30分钟） |
| `threshold_agent_h` | int | 4 | Agent 失联阈值（小时） |

**响应 200**:

```json
{
  "stale_issues": [
    { "title": "...", "url": "...", "assignee": "Boot", "project": "hxa-dash", "stale_hours": 96 }
  ],
  "unreviewed_mrs": [
    { "title": "...", "url": "...", "author": "Boot", "project": "hxa-dash", "hours_open": 36 }
  ],
  "stale_mrs": [
    { "title": "...", "url": "...", "author": "Boot", "reviewer": "Jessie", "project": "hxa-dash", "stale_minutes": 45 }
  ],
  "idle_agents": [
    { "name": "Domi", "last_seen_hours": 8 }
  ],
  "total": 4,
  "blockers": [
    {
      "severity": "critical",
      "type": "stale_mr",
      "type_label": "停滞 MR",
      "title": "...",
      "url": "...",
      "assignee": "Boot",
      "reviewer": "Jessie",
      "project": "hxa-dash",
      "stale_minutes": 45
    }
  ],
  "thresholds": {
    "stale_issue_hours": 72,
    "unreviewed_mr_hours": 24,
    "stale_mr_minutes": 30,
    "idle_agent_hours": 4
  }
}
```

**blockers 严重级别**:
- `critical`: stale_mr, stale_issue
- `warning`: unreviewed_mr
- `info`: silent_agent

**注意**: `[ClawMark]` 开头的 Issue 会被自动过滤（它们是反馈标注，非可执行工作项）。

---

### 2.11 Trends — 趋势分析

#### GET /api/trends

每日完成任务趋势 + 活动热力图。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 范围 | 说明 |
|------|------|------|------|------|
| `days` | int | 14 | 1-90 | 回溯窗口（天） |

**响应 200**:

```json
{
  "labels": ["2026-03-08", "2026-03-09", ...],
  "team": [2, 5, 3, ...],
  "agents": {
    "Boot": [1, 3, 2, ...],
    "Jessie": [1, 2, 1, ...]
  },
  "heatmap": [
    [0, 0, 0, 0, 0, 0, 1, 3, 5, 4, 2, 1, 0, 2, 3, 4, 2, 1, 0, 0, 0, 0, 0, 0],
    ...
  ],
  "period_days": 14,
  "total_completed": 25
}
```

**heatmap 结构**: 7 行 (周日=0 ~ 周六=6) x 24 列 (0时~23时)，每个值为该时段的事件数。

---

### 2.12 Pipeline — 依赖管道

#### GET /api/pipeline

基于依赖关系的任务管道视图，含关键路径分析。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `project` | string | 全部 | 按项目名称过滤 |

**响应 200**:

```json
{
  "tasks": [
    {
      "id": "issue-9-150",
      "iid": 150,
      "title": "实现搜索功能",
      "url": "https://git.coco.xyz/...",
      "project": "hxa-dash",
      "projectId": 9,
      "assignee": "Boot",
      "labels": [...],
      "stage": "executing",
      "dependencies": [
        { "iid": 148, "title": "设计搜索 API", "state": "closed", "met": true }
      ],
      "downstreamCount": 2,
      "downstreamIids": [152, 155],
      "updatedAt": 1711100000000,
      "createdAt": 1711000000000,
      "criticalScore": 3,
      "isCritical": true
    }
  ],
  "edges": [
    { "from": 148, "to": 150, "met": true }
  ],
  "summary": {
    "total": 10,
    "executing": 3,
    "assigned": 2,
    "ready": 3,
    "blocked": 2,
    "critical": 1
  },
  "timestamp": 1711100000000
}
```

**stage 定义**:
- `blocked`: 有未满足的依赖
- `ready`: 依赖已满足，无 assignee，可被认领
- `assigned`: 有 assignee 但 agent 离线
- `executing`: 有 assignee 且 agent 在线

**依赖解析**: 从 Issue 描述中解析，支持格式：
- `依赖: #225, #226`（中文）
- `Depends on: #10, #20`（英文）
- `blocked by #5`

**关键路径**: `criticalScore >= 2` 的任务标记为 `isCritical`（阻塞 2+ 下游任务）。

---

### 2.13 MR Board — MR 管道看板

#### GET /api/mr-board

实时从 GitLab API 拉取 open MR，含 Pipeline 状态和瓶颈检测。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `project_id` | int | 全部 | 按 GitLab 项目 ID 过滤（推荐使用） |

**响应 200**:

```json
{
  "mrs": [MR Object, ...],
  "summary": {
    "total": 5,
    "pipeline": {
      "success": 2,
      "failed": 1,
      "running": 1,
      "pending": 0,
      "none": 1,
      "other": 0
    },
    "bottlenecks": 2,
    "critical": 1,
    "warning": 1
  },
  "timestamp": 1711100000000
}
```

MR Object 详细结构见 [5.6 MR Object](#56-mr-object)。

**响应 400**: `{ "error": "Invalid project_id: must be a positive integer" }`

**响应 503**: `{ "error": "GitLab not configured" }`

**瓶颈检测规则**:
- `critical` + `no_reviewer`: 无 reviewer 且空闲 >= 60 分钟
- `critical` + `idle_60m`: 空闲 >= 60 分钟
- `warning` + `idle_30m`: 空闲 >= 30 分钟

---

### 2.14 Projects — 项目管理

#### GET /api/projects

所有项目聚合数据：Issue/MR 统计、速度、健康评分、AI 建议。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "projects": [Project Object, ...],
  "total": 3
}
```

**排序**: 按健康评分升序（最差的排前面，优先暴露问题）。

Project Object 详细结构见 [5.7 Project Object](#57-project-object)。

---

#### GET /api/projects/:name

单个项目详情，含完整任务列表和事件。

- **认证**: 无
- **路径参数**: `name` — 项目名称（URL 编码）

**响应 200**:

```json
{
  "name": "hxa-dash",
  "stats": {...},
  "velocity": {...},
  "health": {...},
  "completion": 75,
  "stale_count": 1,
  "activity": [...],
  "suggestions": [...],
  "last_activity": 1711100000000,
  "tasks": [Task Object, ...],
  "events": [Event Object, ...]
}
```

**响应 404**: `{ "error": "Project not found" }`

---

### 2.15 Tokens — Token 消耗估算

#### GET /api/tokens

基于 GitLab 活动事件估算 Claude API Token 消耗。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `days` | int | 7 | 30 | 回溯窗口（天） |

**响应 200**:

```json
{
  "window_days": 7,
  "estimated": true,
  "methodology": "基于 GitLab 活动事件估算，每类操作按典型 Claude API 用量换算 token 数",
  "event_count": 150,
  "summary": {
    "total_input": 600000,
    "total_output": 200000,
    "total_tokens": 800000,
    "total_cost_usd": 4.80,
    "avg_daily_tokens": 114285,
    "avg_daily_cost_usd": 0.69
  },
  "daily": [
    { "date": "2026-03-15", "input": 80000, "output": 25000 }
  ],
  "agents": [
    {
      "name": "Boot",
      "input": 300000,
      "output": 100000,
      "total": 400000,
      "cost_usd": 2.40
    }
  ],
  "pricing": {
    "input_per_m": 3.00,
    "output_per_m": 15.00
  }
}
```

**Token 估算参考**:

| 操作 | 估算 Token | 输出占比 |
|------|-----------|---------|
| pushed | 8,000 | 25% |
| commented | 3,000 | 35% |
| mr_opened | 12,000 | 30% |
| mr_merged | 2,000 | 20% |
| issue_opened | 5,000 | 30% |
| issue_closed | 1,500 | 20% |
| reviewed | 6,000 | 30% |
| approved | 1,000 | 20% |
| 其他 | 3,000 | 20% |

---

### 2.16 Auto-Assign — 自动分配

#### POST /api/auto-assign/execute

执行 GitLab Issue 重分配。直接调用 GitLab API 修改 Issue assignee。

- **认证**: 无
- **请求体**:

```json
{
  "project_id": 9,
  "issue_iid": 142,
  "assignee_username": "Boot",
  "reason": "workload rebalance",
  "from_agent": "Jessie"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `project_id` | int | 是 | GitLab 项目 ID |
| `issue_iid` | int | 是 | Issue IID |
| `assignee_username` | string | 是 | 目标 Agent 名称（会自动映射为 GitLab username） |
| `reason` | string | 否 | 分配原因 |
| `from_agent` | string | 否 | 原 Agent 名称 |

**响应 200**:

```json
{
  "ok": true,
  "event": {
    "ts": 1711100000000,
    "project_id": 9,
    "issue_iid": 142,
    "from_agent": "Jessie",
    "to_agent": "Boot",
    "reason": "workload rebalance"
  }
}
```

**响应 400**: `{ "error": "project_id, issue_iid, and assignee_username are required" }`

**响应 404**: `{ "error": "GitLab user not found: boot" }`

---

#### POST /api/auto-assign/smart

技能感知智能分配。根据 Issue 标签/内容匹配最佳 Agent，自动分配。

- **认证**: 无
- **请求体**:

```json
{
  "task_id": "issue-9-142"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | 是 | 任务 ID（格式: `issue-{project_id}-{iid}`） |

**响应 200**:

```json
{
  "ok": true,
  "assignee": "Boot",
  "recommendation": {
    "issue_skills": ["nodejs", "frontend"],
    "candidates": [
      { "agent": "Boot", "score": 85 },
      { "agent": "Jessie", "score": 60 }
    ]
  },
  "event": {
    "ts": 1711100000000,
    "project_id": 9,
    "issue_iid": 142,
    "from_agent": "unassigned",
    "to_agent": "Boot",
    "reason": "smart-assign (score: 85, skills: nodejs,frontend)"
  }
}
```

**响应 400**: `{ "error": "task_id required" }` / `{ "error": "Only issues can be smart-assigned" }` / `{ "error": "Issue is not open" }`

**响应 404**: `{ "error": "Task not found: issue-9-999" }`

**响应 503**: `{ "error": "No available agents for assignment" }`

---

#### POST /api/auto-assign/claim

Agent 自认领任务（去中心化分配）。

- **认证**: 无
- **请求体**:

```json
{
  "task_id": "issue-9-142",
  "agent": "Boot"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | 是 | 任务 ID |
| `agent` | string | 是 | 认领的 Agent 名称 |

**响应 200**: `{ "ok": true, "event": {...} }`

**响应 400**: `{ "error": "task_id and agent are required" }` / `{ "error": "Unknown agent: ..." }` / `{ "error": "Only issues can be claimed" }`

**响应 404**: `{ "error": "Task not found: ..." }`

**响应 409**: `{ "error": "Already assigned to Jessie" }`

---

#### GET /api/auto-assign/history

获取自动分配历史记录。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 最大 | 说明 |
|------|------|------|------|------|
| `limit` | int | 20 | 50 | 返回记录数 |

**响应 200**:

```json
{
  "events": [
    {
      "ts": 1711100000000,
      "project_id": 9,
      "issue_iid": 142,
      "from_agent": "unassigned",
      "to_agent": "Boot",
      "reason": "self-claim by Boot"
    }
  ]
}
```

---

#### GET /api/auto-assign/unassigned

获取所有未分配的 open Issue，附带推荐 assignee。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `project` | string | 全部 | 按项目名称过滤 |

**响应 200**:

```json
{
  "count": 5,
  "issues": [
    {
      "id": "issue-9-155",
      "title": "添加暗黑模式",
      "project": "hxa-dash",
      "url": "https://git.coco.xyz/...",
      "labels": ["feature"],
      "created_at": 1711000000000,
      "updated_at": 1711050000000,
      "recommendation": {
        "issue_skills": ["css", "frontend"],
        "candidates": [
          { "agent": "Boot", "score": 90 }
        ]
      }
    }
  ]
}
```

---

#### GET /api/auto-assign/recommend

获取推荐但不执行分配。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | 是 | 任务 ID |

**响应 200**:

```json
{
  "task_id": "issue-9-142",
  "title": "实现搜索功能",
  "recommendation": {
    "issue_skills": ["nodejs", "search"],
    "candidates": [
      { "agent": "Boot", "score": 85 }
    ]
  }
}
```

**响应 400**: `{ "error": "task_id query param required" }`

**响应 404**: `{ "error": "Task not found: ..." }`

---

### 2.17 Overview — 聚合概览

#### GET /api/overview

Agent 友好的聚合概览，支持 JSON 和纯文本（Markdown）两种格式。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `format` | string | JSON | `text` 返回 Markdown 纯文本 |

**响应 200（JSON）**:

```json
{
  "timestamp": "2026-03-22T10:00:00.000Z",
  "team": {
    "total": 5,
    "online": 3,
    "busy": 2,
    "idle": 1,
    "offline": 2
  },
  "board": {
    "todo": 5,
    "doing": 8,
    "done": 50
  },
  "blockers": [
    {
      "type": "stale_mr",
      "severity": "critical",
      "title": "...",
      "url": "...",
      "author": "Boot",
      "reviewer": null,
      "project": "hxa-dash",
      "stale_minutes": 45
    }
  ],
  "agents": [
    {
      "name": "Boot",
      "online": true,
      "status": "busy",
      "open_tasks": 3,
      "current_work": [
        { "title": "...", "url": "...", "project": "hxa-dash", "type": "issue" }
      ]
    }
  ],
  "unassigned_tasks": [
    { "title": "...", "url": "...", "project": "hxa-dash", "type": "issue" }
  ],
  "recent_activity": [
    {
      "agent": "Boot",
      "action": "pushed",
      "target": "fix alignment",
      "project": "hxa-dash",
      "timestamp": 1711100000000
    }
  ],
  "collab": { "nodes": 5, "edges": 8 }
}
```

**响应 200（`?format=text`）**: 返回 `text/plain`，内容为格式化的 Markdown 摘要。

---

### 2.18 Diagnostics — 系统诊断

#### GET /api/diagnostics

多维系统健康诊断：本地系统 + Agent 状态 + 服务端点探测。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "timestamp": 1711100000000,
  "overall": "ok",
  "uptime_seconds": 86400,
  "system": {
    "hostname": "jessie-server",
    "platform": "Linux 6.1.0",
    "arch": "x64",
    "cpu_count": 4,
    "cpu_model": "Intel Xeon",
    "load_avg": [0.5, 0.3, 0.2]
  },
  "memory": {
    "status": "ok",
    "total_gb": 16.0,
    "used_gb": 8.5,
    "free_gb": 7.5,
    "pct": 53
  },
  "disk": {
    "status": "ok",
    "total": "100G",
    "used": "45G",
    "pct": 45
  },
  "pm2": {
    "status": "ok",
    "online": 5,
    "total": 5,
    "services": [
      {
        "name": "hxa-dash",
        "status": "online",
        "pid": 12345,
        "uptime": 86400000,
        "restarts": 0,
        "memory": 52428800,
        "cpu": 2
      }
    ]
  },
  "services": [
    {
      "name": "HxA Dash",
      "url": "http://localhost:3479/api/health",
      "category": "internal",
      "status": "ok",
      "http_status": 200,
      "latency_ms": 5
    },
    {
      "name": "GitLab",
      "url": "https://git.coco.xyz/api/v4/version",
      "category": "platform",
      "status": "ok",
      "http_status": 200,
      "latency_ms": 120
    }
  ],
  "agents": {
    "status": "warning",
    "online": 3,
    "total": 5,
    "list": [
      {
        "name": "Boot",
        "online": true,
        "status": "active",
        "last_seen_at": 1711100000000,
        "last_active": 1711099800000,
        "open_tasks": 3,
        "system_health": { "...": "见 Agent Health Object" },
        "system_health_stale": false
      }
    ]
  }
}
```

**overall 状态判定**: 综合 memory/disk/pm2/services/agents 状态，任一 `critical` = `critical`，任一 `error`/`warning` = `warning`。

**探测目标**:

| 名称 | URL | 分类 |
|------|-----|------|
| HxA Dash | `http://localhost:3479/api/health` | internal |
| GitLab | `https://git.coco.xyz/api/v4/version` | platform |
| HxA Hub | `https://jessie.coco.site/hub/api/health` | platform |
| HxA Link | `https://jessie.coco.site/api/health` | platform |

**Agent 活动状态**:
- `active`: 在线 + 5 分钟内有事件
- `idle`: 在线但 5 分钟内无事件
- `recently_seen`: 离线但 30 分钟内有事件
- `offline`: 离线且超过 30 分钟无事件

---

### 2.19 Agent Health — Agent 系统健康

#### POST /api/agent-health/:name

Agent 上报自身系统指标（磁盘、内存、CPU、PM2）。**需要认证**。

- **认证**: `HEALTH_API_KEY`（Bearer Token 或 X-API-Key）
- **路径参数**: `name` — Agent 名称
- **请求体**:

```json
{
  "hostname": "boot-server",
  "disk": {
    "pct": 45.2,
    "used": "45G",
    "total": "100G"
  },
  "memory": {
    "pct": 53.1,
    "used_gb": 8.5,
    "total_gb": 16.0
  },
  "cpu": {
    "pct": 15.3,
    "load_avg": [0.5, 0.3, 0.2],
    "cores": 4
  },
  "pm2": {
    "online": 5,
    "total": 5,
    "services": [
      { "name": "hxa-dash", "status": "online", "memory": 52428800, "cpu": 2 }
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `hostname` | string | 否 | 主机名（最长 128 字符） |
| `disk` | object | 是 | 磁盘信息 |
| `disk.pct` | number | 是 | 使用率（0-100） |
| `disk.used` | string | 否 | 已用空间 |
| `disk.total` | string | 否 | 总空间 |
| `memory` | object | 是 | 内存信息 |
| `memory.pct` | number | 是 | 使用率（0-100） |
| `memory.used_gb` | number | 否 | 已用 GB |
| `memory.total_gb` | number | 否 | 总 GB |
| `cpu` | object | 否 | CPU 信息 |
| `pm2` | object | 否 | PM2 服务信息 |

**响应 200**: `{ "ok": true }`

**响应 400**: `{ "error": "disk and memory are required" }`

**响应 401**: `{ "error": "Unauthorized" }`

**响应 403**: `{ "error": "HEALTH_API_KEY not configured on server" }`

**响应 404**: `{ "error": "Agent not found" }`

**输入净化**: 字符串会去除 HTML 标签并截断，数字会 clamp 到合理范围。

---

#### GET /api/agent-health

获取所有 Agent 的系统健康数据。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "agents": [
    {
      "name": "Boot",
      "online": true,
      "overall": "ok",
      "stale": false,
      "health": { "...": "见 Agent Health Object" }
    }
  ],
  "timestamp": 1711100000000
}
```

**overall 状态**:
- `ok`: 所有维度正常
- `warning`: 任一维度 > 80%
- `critical`: 任一维度 > 90%
- `unknown`: 无健康数据或数据过期

**stale 判定**: 健康数据超过 10 分钟未更新则为 `true`。

---

#### GET /api/agent-health/:name

获取单个 Agent 的系统健康数据。

- **认证**: 无
- **路径参数**: `name` — Agent 名称

**响应 200**:

```json
{
  "name": "Boot",
  "online": true,
  "stale": false,
  "health": {
    "hostname": "boot-server",
    "disk": { "pct": 45.2, "used": "45G", "total": "100G", "status": "ok" },
    "memory": { "pct": 53.1, "used_gb": 8.5, "total_gb": 16.0, "status": "ok" },
    "cpu": { "pct": 15.3, "load_avg": [0.5, 0.3, 0.2], "cores": 4 },
    "pm2": { "online": 5, "total": 5, "services": [...] },
    "reported_at": 1711099800000
  },
  "timestamp": 1711100000000
}
```

**响应 404**: `{ "error": "Agent not found" }`

---

### 2.20 PM2 — 服务管理

#### GET /api/pm2/services

获取 PM2 服务列表，含预期服务检测（缺失/异常告警）。

- **认证**: 无
- **查询参数**: 无

**响应 200**:

```json
{
  "status": "ok",
  "online": 5,
  "total": 5,
  "services": [
    {
      "name": "hxa-dash",
      "status": "online",
      "pid": 12345,
      "uptime": 86400000,
      "restarts": 0,
      "memory": 52428800,
      "cpu": 2
    }
  ],
  "missing": [
    { "name": "hxa-link", "description": "消息桥接服务", "critical": true }
  ],
  "alerts": [
    { "name": "hxa-link", "status": "missing", "type": "missing", "critical": true }
  ],
  "timestamp": 1711100000000
}
```

**status 判定**:
- `critical`: 有关键预期服务缺失
- `warning`: 有服务非 online 或有非关键告警
- `ok`: 所有服务在线且无缺失

**预期服务**: 从 `config/expected-services.json` 加载。

---

#### POST /api/pm2/:service/restart

重启指定 PM2 服务。**需要认证**。

- **认证**: `HEALTH_API_KEY`
- **路径参数**: `service` — 服务名称（仅允许字母、数字、连字符、下划线）

**响应 200**:

```json
{
  "ok": true,
  "service": {
    "name": "hxa-dash",
    "status": "online",
    "pid": 12346,
    "uptime": 1000,
    "restarts": 1,
    "memory": 52428800,
    "cpu": 0
  }
}
```

**响应 400**: `{ "error": "Invalid service name" }`

**响应 401**: `{ "error": "Unauthorized" }`

**响应 404**: `{ "error": "Service \"xxx\" not found in PM2" }`

---

### 2.21 System — 系统端点

#### GET /api/about

版本和系统信息。

- **认证**: 无

**响应 200**:

```json
{
  "version": "1.2.0",
  "uptime": "2h 30m (since 2026-03-22 07:30)",
  "node": "v20.11.0",
  "scopes": "2 scopes"
}
```

---

#### GET /api/health

轻量系统健康检查。

- **认证**: 无

**响应 200**:

```json
{
  "status": "ok",
  "uptime_seconds": 9000,
  "clients": 3,
  "timestamp": 1711100000000,
  "data": {
    "agents_loaded": 5,
    "tasks_loaded": 80,
    "events_in_store": 500,
    "gitlab_sources": 3
  }
}
```

---

#### GET /api/scopes

获取可用管理域（多 Connect Server x 组织）。

- **认证**: 无

**响应 200**:

```json
{
  "servers": [
    {
      "hub": "https://jessie.coco.site/hub",
      "orgs": [
        { "id": "coco", "name": "CocoAI" }
      ]
    }
  ],
  "scopes": [
    { "id": "coco", "name": "CocoAI", "hub": "https://jessie.coco.site/hub" }
  ],
  "default": "coco"
}
```

---

#### GET /api/health-watchdog/alerts

获取健康看门狗的当前告警列表。

- **认证**: 无

**响应 200**: 返回当前活跃的告警数组。

---

### 2.22 Graph — 协作图谱

#### GET /api/graph

获取 Agent 协作关系图谱（节点和边）。

- **认证**: 无
- **查询参数**:

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `project` | string | 全部 | 按项目名称过滤 |

**响应 200**:

```json
{
  "nodes": [
    { "id": "Boot", "online": true }
  ],
  "edges": [
    {
      "source": "Boot",
      "target": "Jessie",
      "type": "review",
      "weight": 5,
      "updated_at": 1711100000000
    }
  ]
}
```

**边类型**: `review`（MR 审查）、`comment`（评论互动）

---

## 3. Webhooks

### 3.1 HxA Connect Webhook

#### POST /api/webhook/connect

接收 HxA Connect 的 Agent 上下线回调。

- **路由**: 在 `report.js` 中注册
- **认证**: 无
- **请求体**:

```json
{
  "event": "bot.online",
  "bot": {
    "name": "Boot",
    "role": "developer",
    "bio": "Full-stack AI agent",
    "tags": ["nodejs", "frontend"]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | `bot.online` 或 `bot.offline` |
| `bot.name` | string | 是 | Agent 名称 |
| `bot.role` | string | 否 | 角色 |
| `bot.bio` | string | 否 | 简介 |
| `bot.tags` | string[] | 否 | 标签 |

**副作用**:
- 更新 Agent 在线状态
- 插入 `came_online` / `went_offline` 事件
- 广播 `team:update` 和 `timeline:new`

**响应 200**: `{ "ok": true }`

**响应 400**: `{ "error": "event and bot.name required" }`

---

### 3.2 GitLab Webhook（Report 模块）

#### POST /api/webhook/gitlab

接收 GitLab 群组 Webhook 事件。处理 Push、MR、Issue、Note 四种事件类型。

- **路由**: 在 `report.js` 中注册
- **认证**: `X-GitLab-Token` header（对应 `config.webhooks.gitlab_secret`）
- **请求体**: GitLab 标准 Webhook Payload

**支持的事件类型**:

| X-GitLab-Event | 处理逻辑 |
|----------------|----------|
| `Push Hook` | 为每个 commit 插入 `pushed` 事件 |
| `Tag Push Hook` | 同 Push Hook |
| `Merge Request Hook` | upsert MR task + 插入 `mr_{action}` 事件 + 追踪 reviewer 协作边 |
| `Issue Hook` | upsert Issue task + 插入 `issue_{action}` 事件 |
| `Note Hook` | 插入 `commented` 事件 + 追踪评论协作边 |
| `Confidential Note Hook` | 同 Note Hook |

**副作用**:
- 更新 tasks/events/collab_edges 数据
- 广播 `board:update`、`timeline:new`、`graph:update`

**响应 200**: `{ "ok": true, "handled": true }`

**响应 401**: `{ "error": "invalid token" }`

**用户名映射**: 通过 Entity 层和 `config.gitlab.username_map` 将 GitLab 用户名解析为规范 Agent 名称。

---

### 3.3 GitLab Webhook（依赖触发模块）

#### POST /api/webhook/gitlab

独立的 GitLab Webhook 处理器，专门处理 Issue 关闭事件以触发下游依赖。

- **路由**: 在 `webhook.js` 中注册
- **认证**: `X-GitLab-Token` header
- **触发条件**: 仅处理 `Issue Hook` + `action === 'close'`

**处理逻辑**:
1. 解析被关闭 Issue 的 IID 和项目 ID
2. 查找同项目中依赖此 Issue 的下游 Issue
3. 检查每个下游 Issue 的所有依赖是否都已关闭
4. 对依赖全部满足的 Issue 插入 `unblocked` 事件
5. 广播 `board:update` 和 `timeline:new`

**响应 200（处理）**: `{ "status": "processed", "closed_iid": 150, "unblocked": [...] }`

**响应 200（忽略）**: `{ "status": "ignored", "reason": "not an issue close event" }`

**响应 403**: `{ "error": "invalid token" }`

---

## 4. WebSocket 频道

### 连接方式

```
ws://<host>:3479/ws
```

### 消息格式

所有消息为 JSON，统一格式：

```json
{
  "type": "<频道名>",
  "data": { ... },
  "ts": 1711100000000
}
```

### 频道列表

| 频道 | 触发时机 | 数据内容 | 频率 |
|------|----------|----------|------|
| `snapshot` | 客户端连接时 + 每次完整轮询后 | 完整快照 | 连接时 + ~60s |
| `team:update` | Agent 状态变更 / Connect 轮询（30s） | Agent 列表 | ~30s |
| `board:update` | GitLab 轮询 / Webhook | 任务看板数据 | ~60s |
| `timeline:new` | GitLab 轮询 / Webhook | 最近50条事件 | ~60s |
| `graph:update` | GitLab 轮询后协作分析 | 协作图谱 | ~60s |
| `metrics:update` | GitLab 轮询后 | 团队指标 | ~60s |
| `pm2:update` | PM2 服务状态变更 | PM2 服务状态 | 30s（仅状态变更时发送） |
| `health-watchdog:alert` | 健康看门狗检测到异常 | 告警信息 | 5 分钟检查一次 |

### 频道详情

#### snapshot

客户端首次连接时自动推送完整数据快照，后续每次完整轮询循环也会广播。

```json
{
  "type": "snapshot",
  "data": {
    "team": [Agent Object, ...],
    "board": { "todo": [...], "doing": [...], "done": [...] },
    "timeline": [Event Object, ...],
    "graph": { "nodes": [...], "edges": [...] },
    "metrics": { "team": {...}, "agents": [...] },
    "projects": { "projects": [...], "total": 3 }
  },
  "ts": 1711100000000
}
```

#### team:update

Agent 在线状态变更或 Connect 轮询更新。

```json
{
  "type": "team:update",
  "data": [Agent Object, ...],
  "ts": 1711100000000
}
```

#### board:update

任务看板数据更新。

```json
{
  "type": "board:update",
  "data": { "todo": [...], "doing": [...], "done": [...] },
  "ts": 1711100000000
}
```

#### timeline:new

最新事件（最多50条）。

```json
{
  "type": "timeline:new",
  "data": [Event Object, ...],
  "ts": 1711100000000
}
```

#### graph:update

协作图谱更新。

```json
{
  "type": "graph:update",
  "data": { "nodes": [...], "edges": [...] },
  "ts": 1711100000000
}
```

#### metrics:update

团队指标更新。

```json
{
  "type": "metrics:update",
  "data": { "team": {...}, "agents": [...] },
  "ts": 1711100000000
}
```

#### pm2:update

PM2 服务状态变更时推送（仅状态实际变化时发送，避免无意义广播）。

```json
{
  "type": "pm2:update",
  "data": {
    "status": "warning",
    "online": 4,
    "total": 5,
    "services": [...]
  },
  "ts": 1711100000000
}
```

#### health-watchdog:alert

健康看门狗检测到异常时推送告警。

---

## 5. 共享数据模型

### 5.1 Agent Object

`GET /api/team` 返回的丰富 Agent 对象。

```json
{
  "name": "Boot",
  "role": "developer",
  "bio": "Full-stack AI agent",
  "tags": ["nodejs", "frontend"],
  "online": true,
  "last_seen_at": 1711100000000,
  "updated_at": 1711100000000,
  "work_status": "busy",
  "active_projects": ["hxa-dash", "hxa-link"],
  "top_collaborator": { "name": "Jessie", "weight": 12 },
  "capacity": { "current": 3, "max": 5 },
  "health_score": 85,
  "last_active_at": 1711099800000,
  "blocking_mrs": [
    { "title": "...", "url": "...", "stale_minutes": 20 }
  ],
  "current_tasks": [
    {
      "title": "Fix UI alignment",
      "type": "issue",
      "state": "opened",
      "url": "https://git.coco.xyz/...",
      "project": "hxa-dash",
      "updated_at": 1711090000000
    }
  ],
  "latest_event": {
    "action": "pushed",
    "target_title": "fix alignment",
    "timestamp": 1711099800000,
    "project": "hxa-dash"
  },
  "stats": {
    "open_tasks": 3,
    "closed_tasks": 15,
    "mr_count": 12,
    "issue_count": 20,
    "recent_events": 5,
    "closed_last_7d": 4,
    "closed_last_30d": 12,
    "avg_completion_ms": 7200000
  }
}
```

**work_status**: `busy`（在线 + 有 open task）/ `idle`（在线无 task）/ `offline`

**health_score** (0-100): 基于活动频率(0-40) + 完成率(0-30) + 负载均衡(0-30) 计算。

**capacity**: `current` = 当前 open task 数，`max` = 默认上限 5。

---

### 5.2 Task Object

任务对象，代表 GitLab Issue 或 MR。

```json
{
  "id": "issue-9-142",
  "type": "issue",
  "title": "实现搜索功能",
  "state": "opened",
  "assignee": "Boot",
  "author": "Kevin",
  "project": "hxa-dash",
  "url": "https://git.coco.xyz/hxanet/hxa-dash/-/issues/142",
  "labels": ["feature", "workflow::in-progress"],
  "estimate": "M",
  "reviewer": "Jessie",
  "iid": 142,
  "project_id": 9,
  "description": "...",
  "created_at": 1711000000000,
  "updated_at": 1711090000000
}
```

**id 格式**: `{type}-{project_id}-{iid}`，例如 `issue-9-142`、`mr-9-55`

**state 取值**: `opened` / `closed` / `merged`

**type 取值**: `issue` / `mr`

**看板分类**: 见 [2.2 Board](#22-board--任务看板)

---

### 5.3 Event Object

时间线事件对象。

```json
{
  "agent": "Boot",
  "action": "pushed",
  "target_title": "fix(ui): button alignment",
  "target_url": "https://git.coco.xyz/...",
  "target_type": "commit",
  "project": "hxa-dash",
  "timestamp": 1711100000000,
  "external_id": "commit:abc123"
}
```

**action 取值**:

| action | 来源 | 说明 |
|--------|------|------|
| `pushed` | GitLab Push Hook / 轮询 | 代码推送 |
| `commented` | GitLab Note Hook / 轮询 | 评论 |
| `mr_opened` | GitLab MR Hook | MR 创建 |
| `mr_merged` | GitLab MR Hook | MR 合并 |
| `mr_updated` | GitLab MR Hook | MR 更新 |
| `issue_opened` | GitLab Issue Hook | Issue 创建 |
| `issue_closed` | GitLab Issue Hook | Issue 关闭 |
| `issue_updated` | GitLab Issue Hook | Issue 更新 |
| `came_online` | Connect Webhook | Agent 上线 |
| `went_offline` | Connect Webhook | Agent 下线 |
| `heartbeat` | POST /api/report | 心跳 |
| `working_on` | POST /api/report（带 current_task） | 正在做某事 |
| `unblocked` | 依赖触发 Webhook | 依赖已满足，Issue 解除阻塞 |

**external_id**: 用于去重。格式为 `{type}:{id}:{action}`（如 `mr:123:open`、`note:456`、`commit:abc`）。Webhook 和轮询可能产生重复事件，通过 external_id 去重。

---

### 5.4 Collaboration Edge

协作关系边。

```json
{
  "source": "Boot",
  "target": "Jessie",
  "type": "review",
  "weight": 5,
  "updated_at": 1711100000000
}
```

**type 取值**: `review`（MR 审查）、`comment`（评论互动）

**weight**: 交互次数，每次 review/comment 事件 +1。

---

### 5.5 Agent Health Object

Agent 系统健康数据（通过 POST /api/agent-health/:name 上报）。

```json
{
  "hostname": "boot-server",
  "disk": {
    "pct": 45.2,
    "used": "45G",
    "total": "100G",
    "status": "ok"
  },
  "memory": {
    "pct": 53.1,
    "used_gb": 8.5,
    "total_gb": 16.0,
    "status": "ok"
  },
  "cpu": {
    "pct": 15.3,
    "load_avg": [0.5, 0.3, 0.2],
    "cores": 4
  },
  "pm2": {
    "online": 5,
    "total": 5,
    "services": [
      { "name": "hxa-dash", "status": "online", "memory": 52428800, "cpu": 2 }
    ]
  },
  "reported_at": 1711099800000
}
```

**status 阈值**: `ok`（<= 80%）/ `warning`（80-90%）/ `critical`（> 90%）

**stale 判定**: `reported_at` 超过 10 分钟未更新。

---

### 5.6 MR Object

MR Board 返回的 MR 对象。

```json
{
  "iid": 55,
  "title": "feat(search): add full-text search",
  "url": "https://git.coco.xyz/hxanet/hxa-dash/-/merge_requests/55",
  "project": "hxa-dash",
  "projectId": 9,
  "author": "Boot",
  "reviewers": ["Jessie"],
  "assignees": ["Boot"],
  "pipeline": {
    "status": "success",
    "url": "https://git.coco.xyz/..."
  },
  "createdAt": 1711000000000,
  "updatedAt": 1711090000000,
  "waitMinutes": 120,
  "idleMinutes": 15,
  "bottleneck": {
    "level": "warning",
    "reason": "idle_30m"
  },
  "suggestedReviewers": ["Lisa", "Domi"],
  "sourceBranch": "feat/search",
  "labels": ["feature"],
  "hasConflicts": false,
  "draft": false
}
```

**pipeline.status 取值**: `success` / `failed` / `running` / `pending` / `none` / `error` / `canceled`

**bottleneck.reason 取值**: `no_reviewer` / `idle_60m` / `idle_30m`

**bottleneck.level 取值**: `critical` / `warning`

---

### 5.7 Project Object

项目聚合数据。

```json
{
  "name": "hxa-dash",
  "stats": {
    "issues": { "open": 10, "closed": 45, "total": 55 },
    "mrs": { "open": 3, "merged": 30, "total": 33 },
    "contributors": ["Boot", "Jessie", "Kevin"],
    "contributor_count": 3
  },
  "velocity": {
    "issues_closed_7d": 5,
    "mrs_merged_7d": 3,
    "events_7d": 60
  },
  "health": {
    "score": 75,
    "level": "warning"
  },
  "completion": 82,
  "stale_count": 1,
  "activity": [
    { "day": 0, "timestamp": 1710500000000, "count": 8 },
    { "day": 1, "timestamp": 1710586400000, "count": 12 }
  ],
  "suggestions": [
    {
      "type": "warning",
      "icon": "...",
      "text": "1 个 issue 超过 48h 无更新",
      "action": "triage"
    }
  ],
  "last_activity": 1711100000000
}
```

**health.level**: `healthy`（>= 80）/ `warning`（50-79）/ `critical`（< 50）

**health.score 计算**:
- 基线: 70
- 停滞 Issue: -10/个（最多 -30）
- Open MR 积压: -5/个（超过2个，最多 -15）
- 7 天关闭速度: +5/个（最多 +20）
- 活跃度: +1/5 事件（最多 +10）
- 完成度奖励: >= 90% +10, >= 70% +5

**suggestions.type**: `critical` / `warning` / `info` / `success`

**suggestions.action**: `triage` / `review` / `investigate` / `assign` / `staff` / `sprint` / `plan_next`
