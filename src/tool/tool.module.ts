import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { RedisSaver } from '@langchain/langgraph-checkpoint-redis';
import Redis from 'ioredis';
import { JobModule } from 'src/job/job.module';
import { HitlContextService } from 'src/ai/hitl-context.service';
import { HitlStateService } from 'src/ai/hitl-state.service';
import { LLMService } from './llm.service';
import {
  CHAT_MODEL,
  CONTROLLED_CLI_TOOL,
  CRON_JOB_TOOL,
  LOCAL_SKILL_TOOL,
  MCP_TOOL,
  SEND_MAIL_TOOL,
  TIME_NOW_TOOL,
  WEB_SEARCH_TOOL,
  ASK_USER_CHOICE_TOOL,
  LANGGRAPH_CHECKPOINTER,
  REDIS_CLIENT,
} from 'src/constant';
import { WebSearchToolService } from './web-search-tool.service';
import { SendMailToolService } from './send-mail-tool.service';
import { TimeNowToolService } from './time-now-tool.service';
import { CronJobToolService } from './cron-job-tool.service';
import { McpToolService } from './mcp-tool.service';
import { CliToolService } from './skill-cli-tool.service';
import { AskUserChoiceToolService } from './ask-user-choice-tool.service';
import { LarkSkillLoaderToolService } from './skill-loader-tool.service';
import { SkillProviderRegistry } from './skill-provider.registry';
import { AmapSkillProvider } from './providers/amap-skill.provider';
import { LarkSkillProvider } from './providers/lark-skill.provider';

/**
 * @description ToolModule 负责提供和管理所有 LangChain 工具以及相关的服务。
 * 它集成了各种工具服务（如网页搜索、邮件发送、定时任务、CLI 执行、人机交互等），
 * 并配置了 LangGraph 的检查点机制 (RedisSaver) 和 Redis 客户端。
 */
@Module({
  imports: [ConfigModule, forwardRef(() => JobModule)],
  providers: [
    LLMService,
    WebSearchToolService,
    SendMailToolService,
    TimeNowToolService,
    CronJobToolService,
    McpToolService,
    CliToolService,
    AskUserChoiceToolService,
    LarkSkillLoaderToolService,
    SkillProviderRegistry,
    AmapSkillProvider,
    LarkSkillProvider,
    HitlContextService, // 人机交互上下文服务
    HitlStateService, // 人机交互状态管理服务
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        if (redisUrl) {
          return new Redis(redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 3,
          });
        }
        return new Redis({
          host: configService.get<string>('REDIS_HOST', '127.0.0.1'),
          port: Number(configService.get<string>('REDIS_PORT', '6379')),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
          db: Number(configService.get<string>('REDIS_DB', '0')),
          lazyConnect: true,
          maxRetriesPerRequest: 3,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: LANGGRAPH_CHECKPOINTER,
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');
        const host = configService.get<string>('REDIS_HOST', '127.0.0.1');
        const port = Number(configService.get<string>('REDIS_PORT', '6379'));
        const password = configService.get<string>('REDIS_PASSWORD');
        const db = Number(configService.get<string>('REDIS_DB', '0'));
        const auth = password ? `:${encodeURIComponent(password)}@` : '';
        const fallbackUrl = `redis://${auth}${host}:${port}/${db}`;
        const url = redisUrl || fallbackUrl;
        try {
          // 尝试使用 RedisSaver，需要 Redis Stack 或 Redis 8+ 支持 RedisJSON/RediSearch
          return await RedisSaver.fromUrl(url, {
            defaultTTL: 60, // 检查点默认 TTL 60 秒
            refreshOnRead: true, // 读取时刷新 TTL
          });
        } catch {
          // 如果 RedisSaver 失败（例如 Redis 版本不支持），则回退到内存存储
          return new MemorySaver();
        }
      },
      inject: [ConfigService],
    },
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
    {
      provide: LOCAL_SKILL_TOOL,
      useFactory: (svc: LarkSkillLoaderToolService) => svc.tool,
      inject: [LarkSkillLoaderToolService],
    },
    {
      provide: CONTROLLED_CLI_TOOL,
      useFactory: (svc: CliToolService) => svc.tool,
      inject: [CliToolService],
    },
    {
      provide: ASK_USER_CHOICE_TOOL,
      useFactory: (svc: AskUserChoiceToolService) => svc.tool,
      inject: [AskUserChoiceToolService],
    },
  ],
  exports: [
    CHAT_MODEL,
    WEB_SEARCH_TOOL,
    SEND_MAIL_TOOL,
    CRON_JOB_TOOL,
    TIME_NOW_TOOL,
    MCP_TOOL,
    LOCAL_SKILL_TOOL,
    CONTROLLED_CLI_TOOL,
    ASK_USER_CHOICE_TOOL,
    LANGGRAPH_CHECKPOINTER,
    REDIS_CLIENT,
    HitlContextService,
    HitlStateService,
  ],
})
export class ToolModule {}
