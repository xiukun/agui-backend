import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/constant';

// 定义 HITL (Human-in-the-loop) 状态在 Redis 中的 TTL (Time To Live)，10分钟
const HITL_TTL_SECONDS = 10 * 60;

/**
 * @description 定义用户选择交互的等待状态结构
 * @property threadId - 对应的对话线程ID
 * @property question - 询问用户的问题
 * @property options - 供用户选择的选项列表
 * @property allowMultiple - 是否允许多选
 * @property status - 当前状态 ('waiting' - 等待用户输入, 'resolved' - 用户已选择)
 * @property updatedAt - 状态更新时间
 * @property choice - 用户选择的结果 (单选为字符串，多选为字符串数组)
 */
export type AskUserChoiceWaiting = {
  threadId: string;
  question: string;
  options: Array<{ label: string; value: string }>;
  allowMultiple: boolean;
  status: 'waiting' | 'resolved';
  updatedAt: string;
  choice?: string | string[];
};

/**
 * @description HitlStateService 负责管理 Human-in-the-loop (HITL) 交互的状态。
 * 使用 Redis 存储用户选择的等待状态，支持设置、获取、解决和清除状态。
 */
@Injectable()
export class HitlStateService {
  private readonly logger = new Logger(HitlStateService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * @description 生成 Redis 中存储 HITL 状态的键名
   * @param threadId - 对话线程ID
   * @returns Redis 键名
   */
  private key(threadId: string): string {
    return `hitl:ask-user-choice:${threadId}`;
  }

  /**
   * @description 设置用户选择的等待状态
   * @param input - 包含线程ID、问题、选项和是否允许多选的输入
   */
  async setWaiting(input: {
    threadId: string;
    question: string;
    options: Array<{ label: string; value: string }>;
    allowMultiple?: boolean;
  }): Promise<void> {
    const payload: AskUserChoiceWaiting = {
      threadId: input.threadId,
      question: input.question,
      options: input.options,
      allowMultiple: !!input.allowMultiple,
      status: 'waiting',
      updatedAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.key(input.threadId),
      JSON.stringify(payload),
      'EX',
      HITL_TTL_SECONDS,
    );
  }

  /**
   * @description 获取指定线程的 HITL 状态
   * @param threadId - 对话线程ID
   * @returns HITL 状态对象或 null
   */
  async getState(threadId: string): Promise<AskUserChoiceWaiting | null> {
    const raw = await this.redis.get(this.key(threadId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AskUserChoiceWaiting;
    } catch (error) {
      this.logger.warn(
        `Failed to parse HITL state for thread ${threadId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * @description 解决用户选择的等待状态，记录用户的选择
   * @param threadId - 对话线程ID
   * @param choice - 用户选择的结果
   * @returns 解决状态 ('resolved', 'already_resolved', 'not_found')
   */
  async resolveWaiting(
    threadId: string,
    choice: string | string[],
  ): Promise<'resolved' | 'already_resolved' | 'not_found'> {
    const state = await this.getState(threadId);
    if (!state) return 'not_found';
    if (state.status === 'resolved') return 'already_resolved';

    const next: AskUserChoiceWaiting = {
      ...state,
      status: 'resolved',
      choice,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.key(threadId),
      JSON.stringify(next),
      'EX',
      HITL_TTL_SECONDS,
    );
    return 'resolved';
  }

  /**
   * @description 清除指定线程的 HITL 状态
   * @param threadId - 对话线程ID
   */
  async clear(threadId: string): Promise<void> {
    await this.redis.del(this.key(threadId));
  }
}
