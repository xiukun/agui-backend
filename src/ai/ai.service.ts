import { Inject, Injectable } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, AIMessageChunk, createAgent, createMiddleware, HumanMessage, SystemMessage, Tool, ToolMessage } from 'langchain';
import { UIMessage } from 'ai';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { CHAT_MODEL, SEND_MAIL_TOOL, WEB_SEARCH_TOOL } from 'src/constant';
import z from 'zod';


@Injectable()
export class AiService {
    private readonly agent: ReturnType<typeof createAgent>;

    constructor(
        @Inject(CHAT_MODEL) private readonly chatModel: ChatOpenAI,
        @Inject(WEB_SEARCH_TOOL) private readonly webSearchTool: Tool,
        @Inject(SEND_MAIL_TOOL) private readonly sendMailTool: Tool,
    ) {
        this.agent = createAgent({
            model: this.chatModel,
            tools: [this.webSearchTool, this.sendMailTool],
            systemPrompt: `你是 AI 助手，需要最新信息、事实核查或联网信息时，请使用 web_search 工具搜索后再作答。`,
        })
    }

    async stream(message: UIMessage[]) {
        const lcMessages = await toBaseMessages(message);
        const lgStream = await this.agent.stream({messages: lcMessages},
            {
                streamMode: ['messages','values'],
                recursionLimit: 12
            }
        );
        return toUIMessageStream(lgStream as AsyncIterable<AIMessageChunk>);
    }
}
