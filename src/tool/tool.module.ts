import { Module } from '@nestjs/common';
import { LLMService } from './llm.service';
import { CHAT_MODEL, WEB_SEARCH_TOOL } from 'src/constant';
import { WebSearchToolService } from './web-search-tool.service';
import { ConfigService } from '@nestjs/config';

@Module({
    providers: [
        LLMService,
        WebSearchToolService,
        {
            provide: CHAT_MODEL,
            useFactory: (llmService: LLMService) => llmService.getModel(),
            inject: [LLMService]
        },
        {
            provide: WEB_SEARCH_TOOL,
            useFactory: (webSearchToolService: WebSearchToolService) => webSearchToolService.tool,
            inject: [WebSearchToolService]
        }
    ],
    exports: [CHAT_MODEL]
})
export class ToolModule { }
