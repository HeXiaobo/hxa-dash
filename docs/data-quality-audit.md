# HxA Dash 数据质量审计报告

**审计时间**: 2026-03-14  
**审计人**: Lisa  
**范围**: config/entities.json 数据源准确性 + API 展示数据 vs GitLab 实际数据对比

---

## 总体结论

总体数据质量良好。发现 **1 个高优先级 Bug**（kind 字段不生效）、2 个数据不一致点、1 个健康评分说明问题。

---

## 🔴 Bug #1：`kind` 字段在 entities.json 中配置无效

### 问题描述

`entities.json` 中 Jessie 配置了 `"kind": "human"`，但 dashboard API 返回 `kind: "agent"`，导致 Jessie 显示 🤖 而非 🧑。

### 根因

**`src/entity.js` `loadFromConfig` 函数未将 `kind` 写入 meta：**

```js
// entity.js - loadFromConfig（当前代码，有 bug）
function loadFromConfig(entityConfigs) {
  for (const cfg of entityConfigs) {
    register(cfg.id, cfg.identities || {}, {
      display_name: cfg.display_name || cfg.id,
      role: cfg.role || '',
      bio: cfg.bio || ''
      // ❌ kind 未传入！
    });
  }
}
```

`connect.js` 读取的是 `entMeta.kind`，但 meta 里没有 `kind`，于是永远 fallback 到 `'agent'`：

```js
// connect.js（当前代码）
kind: entMeta.kind || 'agent',  // entMeta.kind 始终 undefined
```

### 修复方案

```js
// entity.js - loadFromConfig（修复后）
register(cfg.id, cfg.identities || {}, {
  display_name: cfg.display_name || cfg.id,
  role: cfg.role || '',
  bio: cfg.bio || '',
  kind: cfg.kind || ''   // ✅ 加上这行
});
```

### 影响范围

- 所有 `kind: 'human'` 配置均不生效
- 当前仅 Jessie 配置了 `kind: 'human'`，她在 Card Wall 显示 🤖（应显示 🧑）
- **MR !24 的 kind fix 只修了 entities.json，未修 entity.js 的传递逻辑**

### 优先级

🔴 高——视觉上人类成员被标记为 Agent，违背 HxA Friendly 设计原则

---

## 🟡 发现 #2：dashboard 展示了 31 个成员，大量非 hxanet 成员

### 问题描述

API `/api/team` 返回 31 个成员，其中 hxanet 核心团队（7 人）之外还有 24 个来自其他 org 的 bot（`zylos*`、`AllenBot`、`DanielBot` 等）。

### 原因

HxA Connect 使用共享 hub，所有 org 的 bot 都出现在 `/hub/agents` 响应中。`connectFetcher` 没有按 org 过滤。

### 当前状态

功能上不影响——非 hxanet 成员没有 GitLab 任务数据，显示为 idle。但 Card Wall 展示 31 人降低了信噪比。

### 建议

在 `connectFetcher` 中按 `config.connect.org` 过滤，只展示 hxanet org 下的成员；或在 entities.json 中配置白名单。

### 优先级

🟡 中——影响使用体验，不影响核心数据准确性

---

## 🟡 发现 #3：4 周趋势只有最后一周有数据

### 问题描述

`/api/metrics` 的 `weekly_closed` 返回：

```json
[
  { "week": "2026-W08", "issues_closed": 0, "mrs_merged": 0 },
  { "week": "2026-W09", "issues_closed": 0, "mrs_merged": 0 },
  { "week": "2026-W10", "issues_closed": 0, "mrs_merged": 0 },
  { "week": "2026-W11", "issues_closed": 81, "mrs_merged": 93 }
]
```

W08/W09/W10 全为 0，但 W11 有大量数据（81 issues closed）。

### 原因分析

两种可能：
1. **正常**：M2 密集交付主要发生在 W11（2026-03-10 以后），历史数据确实如此
2. **SQLite 数据不完整**：GitLab polling 只抓了近期数据，早期活动未进入 DB

目前倾向于原因 1（从 git log 和 MR 时间线看，大量工作确实集中在近 1 周内）。

### 建议

可在 `gitlabFetcher` 中增加初始化时的全量历史拉取（`state=all`，回溯 30 天），避免新部署时趋势图显示全空。

### 优先级

🟡 中——影响趋势图准确性，尤其是新部署后首周

---

## 🟢 发现 #4：健康评分在空闲成员中偏低但合理

### 现象

24 个非 hxanet 成员全部显示 `health_score: 10`。

### 原因

空闲成员（0 任务）：
- 活动新鲜度 = 0（无活动事件）
- 完成率 = 0（无任何任务）
- 负载均衡 = 10（0 任务的固定分值）

得分 10 是算法的预期结果，表示「在线但无贡献」状态。

### 建议

可考虑对无 GitLab 数据的成员单独标注，或从 Card Wall 中过滤。目前行为合理，不影响 hxanet 成员数据。

### 优先级

🟢 低——行为符合预期，外部成员干扰是 #2 的延伸问题

---

## ✅ 数据准确性验证（通过）

| 检查项 | 方式 | 结果 |
|--------|------|------|
| Boot open tasks = 1 | API capacity.current vs GitLab | ✅ 一致（#64 行动建议 ClawMark）|
| vila open tasks = 3 | API vs GitLab | ✅ 一致 |
| lova open tasks = 3 | API vs GitLab | ✅ 一致 |
| Jessie closed_7d 最多（56）| API stats | ✅ 符合实际（大量 MR review + issue 关闭）|
| Boot closed_7d = 27 | API stats | ✅ 符合实际（#162/#189/#192 + hxa-dash MRs）|
| Health score 算法 | 代码审查 | ✅ 逻辑正确（3 维度：活动新鲜度/完成率/负载）|
| XSS 防护 | 代码审查 | ✅ 所有用户数据经 `esc()` 处理 |
| auto-assign 历史 | API `/api/auto-assign/history` | ✅ 端点正常响应 |

---

## 修复优先级汇总

| 序号 | 问题 | 优先级 | 修复估时 |
|------|------|--------|---------|
| 1 | `kind` 字段不传递（entity.js bug）| 🔴 高 | 5 分钟 |
| 2 | Card Wall 展示非 hxanet 成员 | 🟡 中 | 1 小时 |
| 3 | 4 周趋势历史数据不完整 | 🟡 中 | 2 小时 |
| 4 | 空闲成员健康评分偏低 | 🟢 低 | 按需 |

---

*参考历史 Bug：#41（WS 数据与 REST 不一致）、#42（任务 ID 格式不统一），两个均已修复，本次审计确认未复发。*
