## 为什么

当前 Agent 在需要用户决策时，虽然前端已经可以展示交互表单并提交结果，但后端缺少可靠的等待/恢复机制，无法保证在会话中断、重连或跨请求时稳定续跑。现在引入基于 Redis 的等待信号持久化，可将 Human-in-the-loop 从“演示可用”升级为“生产可用”。

## 变更内容

- 为聊天 Agent 增加 `threadId` 维度的会话恢复能力。
- 引入 `ioredis` 持久化 HITL 等待信号（例如等待中的 `toolCallId`、问题、选项、超时时间、状态）。
- 在后端流式对话中实现“遇到 `ask_user_choice` 即暂停并返回交互请求；收到工具结果后继续执行”的断流续跑。
- 前端请求统一携带 `threadId`，并在用户提交工具结果后自动触发下一轮续跑。
- 增加等待状态清理与幂等保护（重复提交、过期提交、无效 toolCallId）。

## 功能 (Capabilities)

### 新增功能
- `hitl-choice-resume`: 支持 Agent 在 ask_user_choice 场景下进行 Redis 持久化等待与跨请求恢复执行。

### 修改功能

## 影响

- 后端：`src/ai` 对话入口与执行流、`src/tool/ask-user-choice-tool.service.ts`、Redis provider 注入。
- 前端：`src/App.tsx` 传递 `threadId` 与自动续跑、`src/components/ToolPanels.tsx` 提交结果载荷。
- 依赖：新增 `ioredis`。
- 运维：需要配置 Redis 连接环境变量（如 `REDIS_HOST/PORT/PASSWORD` 或 `REDIS_URL`）。
