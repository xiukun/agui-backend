## 新增需求

### 需求:会话必须具备可恢复的 HITL 等待状态
当 Agent 调用 `ask_user_choice` 时，系统必须将等待状态持久化到 Redis，并与 `threadId` 和 `toolCallId` 绑定。

#### 场景:生成等待状态
- **当** assistant 轮次产生 `ask_user_choice` 工具调用
- **那么** 后端必须写入 Redis 等待记录，包含 `threadId`、`toolCallId`、`question`、`options`、`allowMultiple`、`status=waiting`、`expiresAt`

#### 场景:等待记录过期
- **当** 等待记录超过 TTL
- **那么** 后端必须将其视为无效等待并拒绝继续恢复，返回明确错误信息

### 需求:工具结果提交必须进行幂等恢复
用户提交 `ask_user_choice` 的结果时，系统必须仅对有效且未解决的等待记录执行一次恢复。

#### 场景:首次提交成功恢复
- **当** 前端提交的 `toolCallId` 与 Redis 中 `status=waiting` 的记录匹配
- **那么** 后端必须原子地将记录更新为 `resolved` 并继续执行 Agent 后续步骤

#### 场景:重复提交同一结果
- **当** 同一 `threadId` + `toolCallId` 已经被标记为 `resolved`
- **那么** 后端必须禁止重复恢复并返回幂等成功或已处理状态，不得再次触发执行

#### 场景:提交无效 toolCallId
- **当** 前端提交的 `toolCallId` 与当前等待记录不匹配
- **那么** 后端必须拒绝恢复并返回可诊断错误

### 需求:前端必须自动携带 threadId 并自动续跑
前端聊天请求必须携带稳定的 `threadId`，并在工具结果提交后自动触发下一次请求续跑。

#### 场景:初始化会话 threadId
- **当** 用户发起首次请求且未提供 threadId
- **那么** 后端必须生成 threadId 并在响应中返回，前端必须保存并在后续请求复用

#### 场景:提交选择后自动继续
- **当** 用户在 `ask_user_choice` 面板中提交单选或多选结果
- **那么** 前端必须调用 `addToolResult` 并自动触发下一轮请求，无需用户额外输入“继续”

## 修改需求

## 移除需求
