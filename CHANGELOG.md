# Changelog

所有版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [Unreleased]

---

## [0.9.0] — M2 P0 收工（2026-03）

### Added
- **#62 Phase 2** — Suggestions 面板新增 3 条 metrics 联动规则：空闲率 ≥ 70% 触发分配建议、周产出下降 > 30% 告警、周期时间中位数 > 48h 建议拆解（`b34145c`）
- **#62 Phase 1** — 团队利用率与产出指标面板：空闲率、7 天 issues/MRs 数、周期时间中位数、4 周趋势柱状图（`30874ef`）
- **#61** — 自动任务重分配引擎：离线 Agent > 30min 触发，每次最多 3 个，发 Connect 通知（`638d1e4`）
- **#43** — 前端增量 DOM 更新 + 进度条：fingerprint diff 只更新变化的 card，`card-enter`/`card-flash` 动画（`c06f266`）
- **#57** — 行动建议面板：5 条规则引擎（高优先级 MR review 超时、issue 停滞；中优先级 idle/过载；低优先级未分配）（`54f6b02`）
- **#58** — HxA Card Wall 统一 Human+Agent 显示：身份徽章 🧑/🤖（`kind` 字段）、活跃/成员术语统一（`386e60e`）
- **#59** — 工作量报表：每人生产力表格 + 柱状图 + JSON 导出（`5d0a399`）
- **#54** — `GET /api/blockers`：过期 issue、等待 review MR、空闲 agent 检测（`562f87e`）
- **#53** — `GET /api/my/:name` 个人视角端点（`f159e3b`）
- **#56** — 前端 Blocker 检测面板（`1331481`）

### Fixed
- **#43 review** — 移除 fingerprint 中 `last_seen_at`（避免每次心跳触发 card-flash）；`card-enter` 动画结束后自动 cleanup（`ae6354b`）
- **#59** — 修正工作量报表周期标签显示（`b3ab901`）
- **#54** — 补充 blockers flat array 兼容前端（`41bde17`）

---

## [0.8.0] — M1 收工（2026-02/03）

### Added
- **#47** — 性能趋势图：日活动柱状图 + 活动热力图（`1a6e2af`）
- **#48** — 统计端点：`/api/stats/timeline`、`/api/stats/trends`、`/api/stats/agents`（`eb6ff98`）
- **#46** — Agent 详情抽屉内活动时间线（`eb6ff98`）
- **#44 + #45** — Agent 卡片增强：活跃项目、最佳协作者、容量指示、健康评分（0–100）；团队容量总览组件（`69acd2b`）

### Fixed
- **#44 + #45 review** — 零除保护、容量常量说明、注释补充（`1ab0809`）
- **#41** — WS broadcast 使用与 REST 相同的 enriched 数据（`5da508a`）
- **#42** — 统一 fetcher 和 webhook 的任务 ID 格式（`d286e20`）

---

## [0.7.0] — 协作分析增强（2026-02）

### Added
- **#35** — 协作热力矩阵视图（`fix(#35)`）；过滤协作图中无贡献节点
- **#39** — Agent 卡片历史统计（7 天/30 天已完成任务数、平均完成时长）（`31e3dc9`）
- **#29** — 协作热力矩阵视图（`fix(#35)`）

### Fixed
- **#40** — 每次轮询推送完整快照（`c4f02f1`）
- **#37** — webhook + 轮询事件去重（`5258923`）
- **#38** — 卡片工作状态徽章 + 可点击任务链接（`e25abe8`）
- **#36** — entity 配置中 role/bio 作为 Agent 卡片回退（`c4f02f1`）
- **#34** — 任务看板分类修复；看板动效（`146939f`）
- **#33** — entity 身份映射 GitLab 用户名修正（`a9abd21`）
- **#32** — 看板动效（`146939f`）
- **#31** — 布局：任务看板移至协作图上方（`8d49896`）
- **#30** — 协作关系 tooltip 信息展示完整（`64be5d3`）
- **#28** — 协作关系图 UX 可读性改进（`e14db11`）

---

## [0.6.0] — Entity 层 + 协作图（2026-02）

### Added
- **#25** — Agent Entity 解析层（Connect 用户名 ↔ GitLab 用户名映射）（`e843c90`）
- **#27** — 协作关系图支持项目过滤（`3dde4f1`）
- **#24** — Agent 卡片统计增强（`8507ad1`）
- **#16** — 主动数据上报端点（`1622b61`）

### Fixed
- **#25 + #26** — 协作图用户名映射修复 + 时间线事件 API 范围修复（`ebd0c63`）

---

## [0.5.0] — 初始可用版本（2026-01）

### Added
- Agent 团队卡片（在线状态、角色、当前任务）
- 任务看板（三列：待办/进行中/已完成）
- 活动时间线（GitLab 事件流）
- 协作关系图（Force-directed graph）
- HxA Connect + GitLab 双数据源
- SQLite 持久化
- Basic Auth 认证
- PM2 部署 + WebSocket 实时推送
