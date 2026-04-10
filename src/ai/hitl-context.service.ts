import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @description 定义 HITL (Human-in-the-loop) 请求的上下文结构。
 * @property threadId - 当前对话线程的唯一标识符。
 */
type HitlRequestContext = {
  threadId: string;
};

/**
 * @description HitlContextService 负责管理 Human-in-the-loop (HITL) 交互的上下文。
 * 它使用 Node.js 的 `AsyncLocalStorage` 来存储和检索当前请求的 `threadId`，
 * 确保在异步操作中也能正确地传递上下文信息。
 */
@Injectable()
export class HitlContextService {
  private readonly storage = new AsyncLocalStorage<HitlRequestContext>();

  /**
   * @description 在指定的 `threadId` 上下文中执行回调函数。
   * @param threadId - 要设置的对话线程ID。
   * @param callback - 在该上下文中执行的回调函数。
   * @returns 回调函数的返回值。
   */
  runWithThreadId<T>(threadId: string, callback: () => T): T {
    return this.storage.run({ threadId }, callback);
  }

  /**
   * @description 获取当前上下文中的 `threadId`。
   * @returns 当前对话线程ID，如果不存在则返回 undefined。
   */
  getThreadId(): string | undefined {
    return this.storage.getStore()?.threadId;
  }
}
