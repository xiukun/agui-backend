## 上下文

当前系统使用 `AiController -> AiService.stream -> createAgent().stream()` 进行流式对话。前端已具备 `ask_user_choice` 表单展示和 `addToolResult` 提交能力，但后端尚未建立可靠的“等待中状态”持久化，因此在断流续跑、重复提交和跨请求恢复上缺乏确定性。

该变更引入 Redis（`ioredis`）作为 HITL 等待信号存储，并在会话维度增加 `threadId`，使 `ask_user_choice` 交互在跨请求场景下可恢复、可幂等。

约束：
- 保持现有 AI SDK 前端与后端接口风格，不引入额外网关。
- MVP 先聚焦 `ask_user_choice`，其他工具保持原流程。
- 对已有会话无 `threadId` 的情况提供向后兼容（后端自动生成）。

## 目标 / 非目标

**目标：**
- 在后端持久化 `threadId` 的等待信号：问题、选项、allowMultiple、toolCallId、状态、过期时间。
- 用户提交工具结果后，可在下一次请求中继续执行，并清理等待信号。
- 保证幂等：重复提交同一 `toolCallId` 不会引发重复继续执行。
- 前端稳定携带 `threadId` 并在提交工具结果后自动继续。

**非目标：**
- 不实现通用工作流编排引擎，仅覆盖 `ask_user_choice`。
- 不引入复杂权限模型（如多用户审批）。
- 不在本次变更中完成长周期审计报表或可视化管理页。

## 决策

1. **使用 Redis 持久化等待信号，而非内存 Map**
   - 理由：支持服务重启后恢复，支持多实例部署，TTL 管理简单。
   - 备选：内存 Map（实现快但不可靠）、MySQL（可行但读写频繁且不如 Redis 轻量）。

2. **以 `threadId` 作为会话主键**
   - 理由：前后端都能稳定传递；与 UI 会话概念一致。
   - 备选：messageId（粒度过细，不适合跨轮恢复）。

3. **等待记录按 `threadId` + `toolCallId` 建模**
   - 理由：同一会话未来可支持多次 HITL；toolCallId 天然用于对齐提交结果。
   - 备选：只存 threadId（无法区分多次询问）。

4. **前端在 `addToolResult` 后自动续跑**
   - 理由：减少用户显式“继续”操作，符合 HITL 期望体验。
   - 备选：手动点击“继续”（可作为降级方案）。

## 风险 / 权衡

- **[风险] threadId 丢失导致会话无法恢复** → 前端本地状态持久化 threadId；后端在缺失时返回新 threadId 并回传。
- **[风险] 重复点击提交产生并发恢复** → Redis 中标记 `resolved` 并使用原子更新（Lua/SETNX+状态检查）保证幂等。
- **[风险] 旧等待记录堆积** → 对等待记录设置 TTL（例如 10 分钟），恢复后立即删除。
- **[权衡] MVP 未做通用 LangGraph Checkpointer** → 先把 Redis 等待信号打通，后续可无缝替换到 LangGraph 持久化执行状态。

## 迁移计划

1. 添加 `ioredis` 依赖与 Redis Provider，注入到 AI 层。
2. 扩展 `/ai/chat` body：支持 `threadId`（可选），响应中返回实际使用的 `threadId`。
3. 新增 `HitlStateService`（Redis 读写）：`setWaiting/getWaiting/resolveWaiting/clearWaiting`。
4. 在 AI 流程中接入等待判断与恢复逻辑：
   - 生成 `ask_user_choice` 时写入 waiting；
   - 收到 tool result 时校验 waiting 并标记 resolved 后继续。
5. 前端改造：
   - 所有请求携带 threadId；
   - `addToolResult` payload 与后端一致；
   - 提交后自动发送下一轮请求触发继续执行。
6. 回滚：关闭 Redis 相关逻辑，保留原 `createAgent().stream()` 路径。

## 开放问题

- 是否需要将等待态同步到观测系统（例如日志聚合或告警）？
- `threadId` 生命周期是否跨页面刷新长期保留，或仅当前会话有效？
