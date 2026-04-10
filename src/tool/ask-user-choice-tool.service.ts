import { Injectable } from '@nestjs/common';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { HitlContextService } from 'src/ai/hitl-context.service';
import { HitlStateService } from 'src/ai/hitl-state.service';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

/**
 * @description AskUserChoiceToolService 负责处理 AI Agent 需要用户进行选择的场景。
 * 这是一个 Human-in-the-loop (HITL) 模式的工具，用于暂停 Agent 的执行，等待用户输入。
 *
 * 后端逻辑流程：
 * 1. **AI 决定交互**: 当 LLM 认为需要用户介入决策时，会调用 `ask_user_choice` 工具。
 * 2. **保存等待状态**: 工具会通过 `HitlStateService` 将当前的用户交互请求（问题、选项等）保存到 Redis 中，并标记为“等待中”。
 * 3. **触发中断**: 使用 `@langchain/langgraph` 的 `interrupt` 功能暂停 Agent 的执行流。
 * 4. **前端渲染**: 前端接收到 `tool-call` 事件，根据工具的 `input` 参数渲染出交互式表单。
 * 5. **用户提交**: 用户在前端做出选择后，前端通过 `addToolResult` 将结果发送回后端。
 * 6. **恢复执行**: `interrupt` 函数接收到用户输入后，Agent 的执行流恢复，并将用户选择的结果作为工具的 `output` 返回给 LLM，LLM 继续后续的推理和行动。
 */
@Injectable()
export class AskUserChoiceToolService {
  readonly tool: StructuredToolInterface;

  constructor(
    private readonly hitlContextService: HitlContextService,
    private readonly hitlStateService: HitlStateService,
  ) {
    // 定义工具的输入参数 Schema
    const schema = z.object({
      question: z.string().describe('需要询问用户的问题或提示信息'),
      options: z.array(z.object({
        label: z.string().describe('选项的显示文本'),
        value: z.string().describe('选项的实际值'),
      })).describe('供用户选择的选项列表'),
      allowMultiple: z.boolean().default(false).describe('是否允许选择多个选项'),
    });

    this.tool = tool(
      /**
       * 工具执行函数：当 AI 调用 ask_user_choice 时触发
       * @param input - 包含问题、选项和是否允许多选的输入
       * @returns 包含用户选择结果的 JSON 字符串
       */
      async (input) => {
        // 获取当前对话线程ID，用于存储和检索 HITL 状态
        const threadId = this.hitlContextService.getThreadId();
        if (threadId) {
          // 将用户交互请求保存到 Redis，标记为等待用户输入
          await this.hitlStateService.setWaiting({
            threadId,
            question: input.question,
            options: input.options,
            allowMultiple: input.allowMultiple,
          });
        }
        // 触发 LangGraph 中断，暂停 Agent 执行，等待用户输入
        const resumeValue = interrupt<{
          type: 'ask_user_choice';
          threadId?: string;
          question: string;
          options: Array<{ label: string; value: string }>;
          allowMultiple: boolean;
        }, { choice?: string | string[]; status?: string } | string | string[]>({
          type: 'ask_user_choice',
          threadId,
          ...input
        });

        // Agent 恢复执行后，将用户选择的结果格式化返回给 LLM
        return JSON.stringify({
          status: 'resumed', // 状态标记为已恢复
          threadId,
          ...input,
          choice:
            typeof resumeValue === 'string' || Array.isArray(resumeValue)
              ? resumeValue
              : resumeValue?.choice,
        });
      },
      {
        name: 'ask_user_choice',
        description: '当需要用户在多个选项中进行单选或多选以决定后续步骤时使用。',
        schema,
      },
    );
  }
}
