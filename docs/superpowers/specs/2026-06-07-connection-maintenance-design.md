# 连接管理定时维护设计

日期：2026-06-07

## 背景

连接管理页展示的账号健康状态、账号令牌、令牌所属分组、分组倍率、路由通道倍率和选中概率都依赖上游平台的实时状态。现有实现已经把余额刷新、账号令牌同步、模型/路由重建和路由决策快照放进定时维护，但账号健康刷新没有纳入维护编排，令牌同步和分组倍率刷新也缺少统一的 5 次失败判定。

当前还存在一个架构风险：余额刷新失败会直接写入账号 `runtimeHealth=unhealthy`，而分组倍率刷新失败时可能退回到 `1.0` 并覆盖旧倍率。这会把短暂网络波动放大成错误的健康状态、路由概率和人民币消费金额。

## 目标

- 连接管理里的关键数据都能定时更新：账号健康、余额、账号令牌、令牌分组、分组倍率、模型覆盖、路由倍率和路由决策快照。
- 远端请求默认重试 5 次，5 次都失败才把对应项判为真正失败。
- 失败时保留 last-known-good 数据，避免用默认值覆盖正确状态。
- 配置策略与现有项目风格一致，放在设置页，不把连接管理页变成运维控制台。
- 维护任务可观测、可测试、可回滚，并且不会并发重叠执行。

## 非目标

- 不把每个维护阶段拆成独立 Cron。
- 不在连接管理页配置维护策略。
- 不改变现有用户数据存储位置，也不重建数据卷。
- 不把临时失败立即展示为不可用或不健康。

## 配置设计

采用高级配置方案，但保持一个主维护计划：

- `connection_maintenance_enabled`：是否启用连接维护，默认 `true`。
- `connection_maintenance_cron`：连接维护 Cron，默认沿用当前 `balance_refresh_cron`。
- `connection_maintenance_retry_attempts`：重试次数，默认 `5`，允许范围 `1-10`。
- `connection_maintenance_attempt_timeout_sec`：单次尝试超时，默认 `15`，允许范围 `3-120`。
- `connection_maintenance_concurrency`：阶段内并发数，默认 `3`，允许范围 `1-16`。
- `connection_maintenance_stages`：阶段开关对象，默认全开。

兼容策略：

- 首版继续读取 `balance_refresh_cron` 作为 fallback。
- 设置页保存新 key。
- 环境变量 `BALANCE_REFRESH_CRON` 暂时继续作为 fallback，不强制改 compose。
- UI 文案把现有“余额刷新 Cron”升级为“连接维护 Cron”。

## 后端架构

新增 `connectionMaintenanceService`，作为连接管理数据维护的唯一编排层。它负责读取配置、互斥锁、分阶段执行、统一重试、结果汇总和事件记录。

固定执行顺序：

1. 站点可访问性轻量探测。
2. 账号余额与账号健康刷新。
3. 账号令牌同步。
4. 令牌所属分组与分组倍率刷新。
5. 模型覆盖刷新。
6. 路由通道倍率更新。
7. 路由决策快照刷新。
8. 账号列表 snapshot 强制刷新。

现有 `periodicMaintenanceService` 可以演进为连接维护的薄包装，或直接由调度器调用 `connectionMaintenanceService.runConnectionMaintenance()`。账号健康刷新逻辑需要从 `routes/api/accounts.ts` 抽到 service，手动接口和定时维护共用同一套实现。

## 重试与失败判定

新增统一 retry helper：

- 默认尝试 5 次。
- 每次尝试有独立超时。
- 支持短退避，避免瞬时抖动导致连续失败。
- 支持按资源维度记录尝试结果。

账号健康规则：

- 第 1-4 次失败只记录尝试日志，不写 `unhealthy`。
- 第 5 次失败才写 `runtimeHealth.state = "unhealthy"`。
- 成功一次即写 `healthy` 或保持已有可解释的 `degraded` 特例，并清除本轮失败。
- `refreshBalance()` 不再负责把单次失败直接写成不健康；健康状态由维护层统一判定。

分组倍率规则：

- 刷新成功才更新倍率。
- 刷新失败保留 last-known-good。
- 不允许用 `1.0` 覆盖旧的正确倍率。
- 失败项记录 `lastError` 和 `failedAttempts`，供界面展示。

阶段失败规则：

- 单个账号、站点或令牌失败不阻断整轮维护。
- 下游阶段只跳过依赖失败数据的项。
- 整体任务返回分阶段 summary，便于后台任务、事件和日志展示。

## 数据模型

新增表 `account_group_ratios`，把分组倍率作为共享事实持久化：

- `id`
- `account_id`
- `site_id`
- `group_name`
- `multiplier`
- `refreshed_at`
- `failed_attempts`
- `last_error`
- `created_at`
- `updated_at`

约束建议：

- `(account_id, site_id, group_name)` 唯一。
- `multiplier > 0`。
- 删除账号或站点时由现有清理流程或后续迁移处理孤儿行。

读取策略：

- 账号令牌管理读取该表展示分组倍率，并附带 `refreshedAt`、`lastError`、`stale`。
- 路由重建读取该表更新自动通道倍率。
- 计费仍使用选中的 route channel multiplier，倍率来源改为可靠持久化数据。

## 界面设计

设置页新增“连接维护”高级区域：

- 启用连接维护。
- 连接维护 Cron。
- 重试次数。
- 单次超时。
- 并发数。
- 维护阶段开关。
- 当前生效状态与保存按钮。

连接管理页只展示数据状态：

- 账号健康状态、更新时间、失败原因。
- 账号令牌的分组、倍率、倍率刷新时间和刷新失败提示。
- 手动刷新按钮可以触发同一套维护 service 的指定阶段或指定账号刷新。

这样设置页负责策略，连接管理页负责观测和操作，职责不混在一起。

## 调度与互斥

连接维护 Cron 触发时必须使用 singleflight lock：

- 上一轮仍在运行时，新一轮跳过或复用运行中任务。
- 日志记录跳过原因。
- 手动触发也使用同一 dedupe key，避免和 Cron 并发。

调度器继续支持运行时设置更新。`updateBalanceRefreshCron` 应演进为 `updateConnectionMaintenanceCron`，保留旧函数作为兼容包装，降低迁移风险。

## 迁移策略

1. 增加 `account_group_ratios` 表迁移。
2. 新配置不存在时从 `balance_refresh_cron` 和环境变量 fallback。
3. 首次维护成功后写入分组倍率表。
4. 旧的实时倍率获取路径保留一段时间作为后备，但不能覆盖 last-known-good。
5. 部署前不删除旧字段和旧设置。

## 测试计划

后端单元测试：

- 账号健康前 4 次失败不写 `unhealthy`，第 5 次失败才写。
- 成功后恢复 `healthy` 并清理本轮失败状态。
- `refreshBalance()` 单次失败不污染健康状态。
- 令牌同步按配置重试 5 次后才 failed。
- 分组倍率刷新失败保留旧倍率，不写 `1.0`。
- 路由重建只更新成功拿到倍率的通道。
- 维护任务重叠时不会并发执行。
- 旧 `balance_refresh_cron` fallback 生效。

前端测试：

- 设置页能加载、修改、保存连接维护配置。
- 连接管理页显示倍率刷新时间、失败原因和 stale 状态。
- 分组倍率为空、失败、成功三类状态格式统一。

集成验证：

- 运行连接维护后账号列表、账号令牌列表、API Key 管理、路由选中概率和消费金额展示一致。
- 在上游分组倍率变化后，下一轮维护更新账号令牌倍率和路由通道倍率。
- 上游短暂不可达时旧倍率仍保留，账号不会立即变成不健康。

## 落地顺序

第一阶段：后端能力。

- 新增 `connectionMaintenanceService`。
- 抽出账号健康刷新 service。
- 新增统一 retry helper。
- 增加 singleflight lock。
- 增加 `account_group_ratios` 表和迁移。
- 定时任务改为调用连接维护服务。

第二阶段：功能接入。

- 账号令牌管理读取持久化倍率。
- 路由重建读取持久化倍率。
- 计费与选中概率继续使用通道 multiplier。
- 维护完成后强制刷新账号 snapshot。

第三阶段：界面配置。

- 设置页新增连接维护高级配置。
- 保存到新 runtime settings。
- 连接管理页展示维护状态、刷新时间和失败原因。

## 风险与控制

- 风险：新增配置过多导致设置页复杂。控制：折叠在高级区域，默认值可直接使用。
- 风险：维护耗时超过 Cron 周期。控制：singleflight lock 和并发限制。
- 风险：新增表和旧实时逻辑短期并存。控制：持久化数据优先，实时逻辑只作为后备且不能覆盖正确旧值。
- 风险：过多失败事件造成噪音。控制：只在最终失败或状态变化时写 error 事件，尝试级别记录在维护结果日志中。
