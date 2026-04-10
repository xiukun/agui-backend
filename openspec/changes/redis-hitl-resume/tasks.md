## 1. 基础设施与会话上下文

- [ ] 1.1 在后端添加 `ioredis` 依赖并创建 Redis Provider（复用常量 token）。
- [ ] 1.2 为 `/ai/chat` 请求模型增加 `threadId` 字段（可选），并将最终 threadId 回传给前端。
- [ ] 1.3 在前端保存并复用 threadId（首次请求后持久化到组件状态）。

## 2. HITL 等待状态持久化

- [ ] 2.1 新增 `HitlStateService`，实现 `setWaiting/getWaiting/resolveWaiting/clearWaiting`。
- [ ] 2.2 设计 Redis key 结构与 TTL（按 `threadId` + `toolCallId`）。
- [ ] 2.3 增加幂等保护：重复提交与无效提交返回可诊断状态。

## 3. AI 执行流改造

- [ ] 3.1 在 `AiService` 中接入等待状态判断与恢复流程。
- [ ] 3.2 让 `ask_user_choice` 在触发时写入等待状态并结束本轮流式输出（断流等待）。
- [ ] 3.3 在下一轮请求中消费 tool result 并继续执行后续步骤。

## 4. 前端交互续跑

- [ ] 4.1 在 `DefaultChatTransport` 请求体中附带 `threadId`。
- [ ] 4.2 调整 `addToolResult` 提交 payload 与后端恢复契约一致。
- [ ] 4.3 提交选择后自动触发下一轮请求，减少手动操作。

## 5. 验证与收尾

- [ ] 5.1 增加关键日志与错误提示（过期等待、重复提交、toolCallId 不匹配）。
- [ ] 5.2 本地验证单选/多选流程：首次提问、提交、自动续跑、重复提交保护。
- [ ] 5.3 更新相关文档说明（新增 Redis 环境变量与 HITL 行为）。
