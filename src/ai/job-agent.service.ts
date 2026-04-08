import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import {
  CHAT_MODEL,
  CONTROLLED_CLI_TOOL,
  LOCAL_SKILL_TOOL,
  MCP_TOOL,
  SEND_MAIL_TOOL,
  TIME_NOW_TOOL,
  WEB_SEARCH_TOOL,
} from '../constant';
import { MemoryService } from '../memory/memory.service';

@Injectable()
export class JobAgentService {
  private readonly logger = new Logger(JobAgentService.name);
  private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;

  constructor(
    @Inject(CHAT_MODEL) model: ChatOpenAI,
    @Inject(SEND_MAIL_TOOL) private readonly sendMailTool: any,
    @Inject(WEB_SEARCH_TOOL) private readonly webSearchTool: any,
    @Inject(TIME_NOW_TOOL) private readonly timeNowTool: any,
    @Inject(MCP_TOOL) private readonly mcpTool: any,
    @Inject(LOCAL_SKILL_TOOL) private readonly localSkillTool: any,
    @Inject(CONTROLLED_CLI_TOOL) private readonly controlledCliTool: any,
    private readonly memoryService: MemoryService,
  ) {
    this.modelWithTools = model.bindTools([
      this.sendMailTool,
      this.webSearchTool,
      this.timeNowTool,
      this.localSkillTool,
      this.controlledCliTool,
      ...this.mcpTool,
    ]);
  }

  async runJob(
    instruction: string,
    options?: { jobId?: string },
  ): Promise<string> {
    const jobId = options?.jobId;

    // 执行前：用 Milvus 检索相关记忆，作为 context 注入
    let memoryBlock = '';
    try {
      const [jobMemories, larkMemories] = await Promise.all([
        jobId
          ? this.memoryService.searchMemory({
              query: instruction,
              topK: 3,
              scopes: ['job_execution'],
              ownerId: jobId,
            })
          : Promise.resolve([]),
        this.memoryService.searchMemory({
          query: instruction,
          topK: 3,
          scopes: ['lark_cli'],
          ownerId: 'global',
        }),
      ]);

      const lines: string[] = [];
      for (const m of jobMemories) {
        lines.push(
          `[job_execution ownerId=${m.ownerId} score=${m.score?.toFixed?.(4) ?? m.score}]\n${m.content}`,
        );
      }
      for (const m of larkMemories) {
        lines.push(
          `[lark_cli ownerId=${m.ownerId} score=${m.score?.toFixed?.(4) ?? m.score}]\n${m.content}`,
        );
      }
      memoryBlock = lines.length ? lines.join('\n\n━━━━━\n\n') : '';
    } catch (e) {
      this.logger.warn(
        `Failed to build memory context: ${(e as Error).message}`,
      );
    }

    const messages: BaseMessage[] = [
      new SystemMessage(
        [
          `你是一个用于执行后台任务的智能代理。工作目录: "${process.cwd()}/workbench",你会根据给定的任务指令，必要时调用工具（如 send_mail、web_search、time_now等）来查询数据，然后给出清晰的步骤和结果说明。`,
          memoryBlock
            ? `\n\n【相关记忆（来自 Milvus 检索）】\n${memoryBlock}`
            : '',
          `\n\n执行时优先参考上面的相关记忆`,
        ].join(''),
      ),
      new HumanMessage(instruction),
    ];

    try {
      while (true) {
        const aiMessage = await this.modelWithTools.invoke(messages);
        messages.push(aiMessage);

        const toolCalls = aiMessage.tool_calls ?? [];

        if (!toolCalls.length) {
          const final = String(aiMessage.content ?? '');
          // 执行后：写回 job_execution 记忆
          try {
            await this.memoryService.upsertMemory({
              scope: 'job_execution',
              ownerId: jobId ?? 'global',
              content: `job_instruction:\n${instruction.slice(0, 2000)}\n\nexecution_result:\n${final.slice(0, 4000)}`,
              tags: ['job_execution'],
            });
          } catch (e) {
            this.logger.warn(
              `Failed to write job_execution memory: ${(e as Error).message}`,
            );
          }
          return final;
        }

        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id || '';
          const toolName = toolCall.name;

          if (toolName === 'send_mail') {
            const result = await this.sendMailTool.invoke(toolCall.args);
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content: result,
              }),
            );
          } else if (toolName === 'web_search') {
            const result = await this.webSearchTool.invoke(toolCall.args);
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content: result,
              }),
            );
          } else if (toolName === 'time_now') {
            const result = await this.timeNowTool.invoke({});
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content: JSON.stringify(result),
              }),
            );
          } else if (toolName === 'load_local_skill') {
            const result = await this.localSkillTool.invoke(toolCall.args);
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content:
                  typeof result === 'string' ? result : JSON.stringify(result),
              }),
            );
          } else if (toolName === 'exec_controlled_cli') {
            const result = await this.controlledCliTool.invoke(toolCall.args);
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content:
                  typeof result === 'string' ? result : JSON.stringify(result),
              }),
            );
          } else if (
            toolName.startsWith('mcp_') ||
            toolName.startsWith('filesystem') ||
            toolName.startsWith('amap')
          ) {
            const tool = this.mcpTool.find((t: any) => t.name === toolName);
            const result = tool
              ? await tool.invoke(toolCall.args)
              : `Tool ${toolName} not found`;
            messages.push(
              new ToolMessage({
                tool_call_id: toolCallId,
                name: toolName,
                content:
                  typeof result === 'string' ? result : JSON.stringify(result),
              }),
            );
          } else {
            this.logger.warn(`未知工具调用: ${toolName}`);
          }
        }
      }
    } catch (e) {
      try {
        await this.memoryService.upsertMemory({
          scope: 'job_execution',
          ownerId: jobId ?? 'global',
          content: `job_instruction:\n${instruction.slice(0, 2000)}\n\nexecution_error:\n${String(
            (e as Error)?.message ?? e,
          ).slice(0, 4000)}`,
          tags: ['job_execution', 'error'],
        });
      } catch {
        // ignore
      }
      throw e;
    }
  }
}
