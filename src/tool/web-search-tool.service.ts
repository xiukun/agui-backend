import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';

@Injectable()
export class WebSearchToolService {
  readonly tool;
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get('TAVILY_API_KEY');
    if (!apiKey) {
      // 注意：在 Factory 中抛出错误会导致应用启动失败
      // 或者你可以直接返回一个占位工具，但在实际生产中建议确保 Key 存在
      console.warn('TAVILY_API_KEY is missing');
    }

    const webStreamArgsSchema = z.object({
      query: z
        .string()
        .min(1)
        .describe('搜索关键词，例如：公司年报、某个事件等'),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('返回的搜索结果数量，默认 10 条'),
    });

    this.tool = tool(
      async ({ query, count }: { query: string; count?: number }) => {
        console.log('web search...', { query, count });
        const innerTool = new TavilySearch({
          tavilyApiKey: apiKey,
          maxResults: count ?? 10,
        });
        const result = await innerTool.invoke({ query });
        return JSON.stringify(result);
      },
      {
        name: 'web_search',
        description:
          '当你需要对某个问题进行网络搜索时使用此工具，可以获取到相关的网页内容',
        schema: webStreamArgsSchema,
      },
    );
  }
}
