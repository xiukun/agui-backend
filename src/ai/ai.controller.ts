import { BadRequestException, Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { UIMessage, pipeUIMessageStreamToResponse } from 'ai';
import { HitlContextService } from './hitl-context.service';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly hitlContextService: HitlContextService,
  ) {}

    /**
    本地测试：
    curl -N -sS -X POST 'http://localhost:3000/ai/chat' \
      -H 'Content-Type: application/json' \
      -d '{"messages":[{"id":"1","role":"user","parts":[{"type":"text","text":"北京今天的天气"}]}]}'
   */
  @Post('chat')
  async postChat(
    @Body() body: { messages?: UIMessage[]; threadId?: string },
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!body?.messages || !Array.isArray(body.messages)) {
      throw new BadRequestException('Invalid JSON');
    }
    const messages = body.messages;

    const threadId = body.threadId?.trim() || randomUUID();
    res.setHeader('x-thread-id', threadId);

    const stream = await this.hitlContextService.runWithThreadId(threadId, () =>
      this.aiService.stream(messages, threadId),
    );
    pipeUIMessageStreamToResponse({ response: res, stream });
  }
}
