import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LLMService } from './llm.service';
import { CHAT_MODEL, SEND_MAIL_TOOL, WEB_SEARCH_TOOL } from 'src/constant';
import { WebSearchToolService } from './web-search-tool.service';
import { SendMailToolService } from './send-mail-tool.service';

@Module({
  imports: [ConfigModule],
  providers: [
    LLMService,
    WebSearchToolService,
    SendMailToolService,
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
  ],
  exports: [CHAT_MODEL, WEB_SEARCH_TOOL, SEND_MAIL_TOOL],
})
export class ToolModule {}
