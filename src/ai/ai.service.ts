import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessageChunk, createAgent, Tool } from 'langchain';
import { UIMessage } from 'ai';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import {
  CHAT_MODEL,
  CONTROLLED_CLI_TOOL,
  CRON_JOB_TOOL,
  LOCAL_SKILL_TOOL,
  MCP_TOOL,
  SEND_MAIL_TOOL,
  TIME_NOW_TOOL,
  WEB_SEARCH_TOOL,
} from 'src/constant';

@Injectable()
export class AiService {
  private readonly agent: ReturnType<typeof createAgent>;

  constructor(
    @Inject(CHAT_MODEL) private readonly chatModel: ChatOpenAI,
    @Inject(WEB_SEARCH_TOOL) private readonly webSearchTool: Tool,
    @Inject(SEND_MAIL_TOOL) private readonly sendMailTool: Tool,
    @Inject(CRON_JOB_TOOL) private readonly cronJobTool: Tool,
    @Inject(TIME_NOW_TOOL) private readonly timeNowTool: Tool,
    @Inject(MCP_TOOL) private readonly mcpTools: Tool[],
    @Inject(LOCAL_SKILL_TOOL) private readonly localSkillTool: Tool,
    @Inject(CONTROLLED_CLI_TOOL) private readonly controlledCliTool: Tool,
  ) {
    this.agent = createAgent({
      model: this.chatModel,
      tools: [
        // this.webSearchTool,
        this.sendMailTool,
        this.cronJobTool,
        this.timeNowTool,
        this.localSkillTool,
        this.controlledCliTool,
        ...this.mcpTools,
      ],
      systemPrompt: `你是工作AI助手，根据用户任务自主调用工具：工作目录: "${process.cwd()}/workbench"。
1. web_search(query, count?) — 联网搜索，查询最新信息、事实核查等。query 为搜索词，count 可选返回条数（默认10条，最多20条）。
2. send_mail(to, subject, text?, html?) — 发送邮件。to 为收件人邮箱，subject 为主题，text/html 二选一。
3. cron_job — 定时任务管理：
   - list：查看所有定时任务
   - add(type, instruction, cron?|everyMs?|date?)：创建任务。instruction 为纯自然语言描述的任务内容，不含时间说明；type 指定执行方式（cron=Cron表达式循环，every=固定间隔毫秒，at=指定时间点一次性）
   - toggle(id, enabled?)：启用/禁用任务
4. time_now() — 获取当前服务器时间（ISO字符串 + 毫秒时间戳）
5. load_local_skill(skillName, includeShared?, referenceFiles?) — 读取当前仓库 skills/ 下的技能说明。处理 amap 或 lark 任务前，优先先读相关 skill 和 reference。
6. exec_controlled_cli(provider, action, args?, confirmWrite?, dryRun?) — 执行白名单 CLI 动作：
   - lark: calendar.agenda, calendar.create, contact.search-user, doc.search, im.send
   - amap: route, searchPOI, mapState
   写操作必须显式 confirmWrite=true；否则只会返回命令预览。
7. MCP工具（如 filesystem_* ）— 通过 MCP 协议接入，包括：
   - filesystem 系列：读取/写入/列出指定目录下的文件

调用规则：处理本地 skills/ 中定义的 amap 或 lark 任务时，优先先调用 load_local_skill 获取规则，再用 exec_controlled_cli 执行白名单动作；需要最新信息时用 web_search；需要发送邮件时用 send_mail；需要定时执行任务时用 cron_job（add）；需要知道当前时间时用 time_now；需要读写文件使用filesystem工具。`,
    });
  }

  async stream(message: UIMessage[]) {
    const lcMessages = await toBaseMessages(message);
    const lgStream = await this.agent.stream(
      { messages: lcMessages },
      {
        streamMode: ['messages', 'values'],
        recursionLimit: 25,
      },
    );
    return toUIMessageStream(lgStream as AsyncIterable<AIMessageChunk>);
  }
}
