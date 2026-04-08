import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JobModule } from 'src/job/job.module';
import { LLMService } from './llm.service';
import {
  CHAT_MODEL,
  CRON_JOB_TOOL,
  MCP_TOOL,
  SEND_MAIL_TOOL,
  TIME_NOW_TOOL,
  WEB_SEARCH_TOOL,
} from 'src/constant';
import { WebSearchToolService } from './web-search-tool.service';
import { SendMailToolService } from './send-mail-tool.service';
import { TimeNowToolService } from './time-now-tool.service';
import { CronJobToolService } from './cron-job-tool.service';
import { McpToolService } from './mcp-tool.service';

@Module({
  imports: [ConfigModule, forwardRef(() => JobModule)],
  providers: [
    LLMService,
    WebSearchToolService,
    SendMailToolService,
    TimeNowToolService,
    CronJobToolService,
    McpToolService,
    {
      provide: CHAT_MODEL,
      useFactory: (llmService: LLMService) => llmService.getModel(),
      inject: [LLMService],
    },
    {
      provide: WEB_SEARCH_TOOL,
      useFactory: (webSearchToolService: WebSearchToolService) =>
        webSearchToolService.tool,
      inject: [WebSearchToolService],
    },
    {
      provide: SEND_MAIL_TOOL,
      useFactory: (svc: SendMailToolService) => svc.tool,
      inject: [SendMailToolService],
    },
    {
      provide: TIME_NOW_TOOL,
      useFactory: (svc: TimeNowToolService) => svc.tool,
      inject: [TimeNowToolService],
    },
    {
      provide: CRON_JOB_TOOL,
      useFactory: (svc: CronJobToolService) => svc.tool,
      inject: [CronJobToolService],
    },
    {
      provide: MCP_TOOL,
      useFactory: async (svc: McpToolService) => await svc.getTools(),
      inject: [McpToolService],
    },
  ],
  exports: [
    CHAT_MODEL,
    WEB_SEARCH_TOOL,
    SEND_MAIL_TOOL,
    CRON_JOB_TOOL,
    TIME_NOW_TOOL,
    MCP_TOOL,
  ],
})
export class ToolModule {}
