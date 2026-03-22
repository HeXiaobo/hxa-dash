# HxA Dash API 契约文档

本目录包含 HxA Dash 的完整 API 契约定义，供前端、集成方和 AI Agent 参考。

## 文件索引

| 文件 | 内容 | 最后更新 |
|------|------|----------|
| [hxa-dash-api.md](./hxa-dash-api.md) | REST API + WebSocket 完整契约 | 2026-03-22 |

## 概述

- **基础地址**: `http://<host>:3479`
- **WebSocket**: `ws://<host>:3479/ws`
- **认证**: 大部分 GET 端点无需认证；写操作（POST）需要 `HEALTH_API_KEY` 或 GitLab webhook secret
- **数据格式**: JSON（`Content-Type: application/json`）
- **端点总数**: ~42 个 REST 端点 + 2 个 Webhook + 8 个 WebSocket 频道

## 快速导航

- REST API 按功能分组：Team / Board / Timeline / Agent / Stats / Metrics / Report / My View / Live / Blockers / Trends / Pipeline / MR Board / Projects / Tokens / Auto-Assign / Overview / Diagnostics / Agent Health / PM2 / System / Graph
- Webhook：HxA Connect 回调、GitLab 群组 Webhook
- WebSocket：实时数据推送频道
- 共享数据模型：Agent / Task / Event / Collab Edge / Agent Health / MR / Project
