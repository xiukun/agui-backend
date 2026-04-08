import { Injectable, Logger } from '@nestjs/common';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'child_process';

/**
 * LarkCliToolService
 *
 * 职责：通过白名单机制安全地执行 lark-cli（飞书）和 amap-gui（高德地图）CLI 工具。
 *
 * 核心设计思路 ——"受控执行"：
 * AI Agent 只能调用预先定义好的动作（action），不能执行任意命令。
 * 这避免了 AI 直接通过 shell 执行危险操作，实现本质安全。
 *
 * 白名单动作分为两类：
 * - 【只读动作】：calendar.agenda、contact.search-user、doc.search、amap:route、amap:searchPOI 等
 *   → 执行前无需确认，直接运行
 * - 【写动作】：calendar.create（创建日程）、im.send（发消息）等
 *   → 必须显式传入 confirmWrite=true，否则只返回命令预览而不执行
 *
 * 工具名称：exec_controlled_cli
 *
 * 安全设计要点：
 * 1. 白名单：只允许预定义的 provider + action 组合，不支持自由命令
 * 2. 参数构造：CLI 参数由代码中的 buildArgs 构造，Agent 只传结构化参数
 * 3. 写操作确认：calendar.create 和 im.send 必须 confirmWrite=true 才真正执行
 * 4. DryRun：可通过 dryRun=true 只看命令预览，不实际执行
 * 5. amap 前置检查：amap-gui 操作前自动检查服务状态，必要时自动启动
 * 6. 结果截断：stdout/stderr 超过 6000 字符自动截断，防止上下文爆炸
 */
@Injectable()
export class LarkCliToolService {
  private readonly logger = new Logger(LarkCliToolService.name);

  /** LangChain StructuredTool 实例，对外暴露给 Agent 调用 */
  readonly tool: StructuredToolInterface;

  constructor() {
    /**
     * 入参 Schema：
     * - provider: 指定 lark（飞书）或 amap（高德地图）
     * - action: 白名单中的具体动作名
     * - args: 结构化参数对象，由工具内部转换为 CLI flags
     * - confirmWrite: 写操作必须传 true 才执行
     * - dryRun: 传 true 则只返回命令字符串，不实际执行
     */
    const controlledCliArgsSchema = z.object({
      provider: z
        .enum(['lark', 'amap'])
        .describe('命令提供方。lark 对应 lark-cli，amap 对应 amap-gui。'),
      action: z
        .string()
        .describe(
          '白名单动作名。支持 lark: calendar.agenda, calendar.create, contact.search-user, doc.search, im.send；支持 amap: route, searchPOI, mapState。',
        ),
      args: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        )
        .optional()
        .describe('结构化参数对象，由工具内部转换为 CLI flags。'),
      confirmWrite: z
        .boolean()
        .optional()
        .describe(
          '写操作确认开关。calendar.create、im.send 执行前必须显式传 true。',
        ),
      dryRun: z
        .boolean()
        .optional()
        .describe('是否附加 --dry-run（仅在 lark-cli 支持时生效）'),
    });

    this.tool = tool(
      /**
       * 工具执行函数：解析动作规格 → 前置检查 → 执行命令 → 解析结果
       */
      async ({
        provider,
        action,
        args,
        confirmWrite,
        dryRun,
      }: {
        provider: 'lark' | 'amap';
        action: string;
        args?: Record<string, string | number | boolean | string[]>;
        confirmWrite?: boolean;
        dryRun?: boolean;
      }) => {
        // 1. 根据 provider + action 查找对应的规格说明
        const spec = this.getActionSpec(provider, action);
        if (!spec) {
          return `不支持的受控动作: ${provider}.${action}`;
        }

        // 2. 将结构化 args 转换为 CLI 参数列表
        const finalArgs = spec.buildArgs(args ?? {});

        // 3. DryRun 模式：只返回构造好的命令，不执行
        if (dryRun) {
          finalArgs.push('--dry-run');
        }

        // 4. 写操作二次确认：如果动作需要确认但未传 confirmWrite=true，
        //    返回 JSON 说明需要确认，不执行命令
        if (spec.requiresConfirmation && !confirmWrite) {
          return JSON.stringify(
            {
              provider,
              action,
              requiresConfirmation: true,
              command: [spec.bin, ...finalArgs].join(' '),
              message:
                '这是写操作。若确认执行，请重新调用并传入 confirmWrite=true。',
            },
            null,
            2,
          );
        }

        // 5. amap 前置检查：确保 amap-gui 服务已启动
        const preflightNotes: string[] = [];
        if (provider === 'amap') {
          const preflight = await this.ensureAmapGuiReady();
          if (!preflight.ok) {
            return JSON.stringify(
              {
                provider,
                action,
                command: [spec.bin, ...finalArgs].join(' '),
                error: preflight.message,
              },
              null,
              2,
            );
          }
          preflightNotes.push(...preflight.notes);
        }

        // 6. 真正执行命令
        const execResult = await this.runCommand(spec.bin, finalArgs);

        // 7. 尝试解析 stdout 为 JSON（方便 Agent 进一步处理）
        const parsed = this.tryParseJson(execResult.stdout);

        // 8. 返回结构化结果
        return JSON.stringify(
          {
            provider,
            action,
            command: [spec.bin, ...finalArgs].join(' '),
            preflight: preflightNotes,
            exitCode: execResult.exitCode,
            success: execResult.exitCode === 0,
            stdout: this.truncate(execResult.stdout),
            stderr: this.truncate(execResult.stderr),
            parsed, // 如果 stdout 是 JSON，会额外放一份解析后的对象
          },
          null,
          2,
        );
      },
      {
        name: 'exec_controlled_cli',
        description:
          '执行受控白名单中的 lark-cli 或 amap-gui 命令。只接受结构化参数，不接受自由文本命令；写操作必须显式 confirmWrite=true。',
        schema: controlledCliArgsSchema,
      },
    );
  }

  // ==================== 动作规格表（Action Specs） ====================
  // 每个 entry 描述了一个白名单动作如何将结构化 args 转换为 CLI 参数

  /**
   * 动作规格表
   *
   * 字段说明：
   * - bin:            要执行的二进制命令（lark-cli 或 amap-gui）
   * - requiresConfirmation: 是否需要写操作确认（confirmWrite=true）
   * - buildArgs:      将 agent 传入的 args 转换为 CLI 参数列表的函数
   *
   * 所有动作的共同点：
   * - 参数以 [flag, value] 的形式追加到命令数组
   * - undefined/null/空字符串 的参数会被跳过（不追加）
   * - 布尔值 true 会追加 flag 本身（无值），false 跳过
   * - 数组类型会被 join(',') 转为逗号分隔字符串
   */
  private getActionSpec(provider: 'lark' | 'amap', action: string) {
    const specs: Record<
      string,
      {
        bin: 'lark-cli' | 'amap-gui';
        requiresConfirmation: boolean;
        buildArgs: (
          args: Record<string, string | number | boolean | string[]>,
        ) => string[];
      }
    > = {
      // -------------------- 飞书只读动作 --------------------
      'lark:calendar.agenda': {
        bin: 'lark-cli',
        requiresConfirmation: false,
        buildArgs: (args) => [
          'calendar',
          '+agenda',
          ...this.pushOption([], '--start', args.start),
          ...this.pushOption([], '--end', args.end),
          ...this.pushOption([], '--calendar-id', args.calendarId),
          ...this.pushOption([], '--format', args.format),
        ],
      },
      // -------------------- 飞书写动作 --------------------
      'lark:calendar.create': {
        bin: 'lark-cli',
        requiresConfirmation: true, // 写操作，需要 confirmWrite=true
        buildArgs: (args) => {
          const command = ['calendar', '+create'];
          // 必填参数校验，缺少则抛错
          this.requireArgs(action, args, ['start', 'end']);
          this.pushOption(command, '--summary', args.summary);
          this.pushOption(command, '--start', args.start);
          this.pushOption(command, '--end', args.end);
          this.pushOption(command, '--description', args.description);
          this.pushOption(command, '--calendar-id', args.calendarId);
          this.pushOption(command, '--rrule', args.rrule);
          this.pushListOption(command, '--attendee-ids', args.attendeeIds);
          return command;
        },
      },
      'lark:contact.search-user': {
        bin: 'lark-cli',
        requiresConfirmation: false,
        buildArgs: (args) => {
          this.requireArgs(action, args, ['query']);
          const command = ['contact', '+search-user'];
          this.pushOption(command, '--query', args.query);
          this.pushOption(command, '--page-size', args.pageSize);
          this.pushOption(command, '--page-token', args.pageToken);
          this.pushOption(command, '--format', args.format);
          return command;
        },
      },
      'lark:doc.search': {
        bin: 'lark-cli',
        requiresConfirmation: false,
        buildArgs: (args) => {
          const command = ['docs', '+search'];
          this.pushOption(command, '--query', args.query);
          this.pushJsonOption(command, '--filter', args.filter);
          this.pushOption(command, '--page-size', args.pageSize);
          this.pushOption(command, '--page-token', args.pageToken);
          this.pushOption(command, '--format', args.format);
          return command;
        },
      },
      'lark:im.send': {
        bin: 'lark-cli',
        requiresConfirmation: true, // 写操作，需要 confirmWrite=true
        buildArgs: (args) => {
          const command = ['im', '+messages-send', '--as', 'bot'];
          this.requireArgs(action, args, ['text']);
          // 至少需要 chatId 或 userId 其一
          if (!args.chatId && !args.userId) {
            throw new Error('im.send 需要 chatId 或 userId 其中之一');
          }
          this.pushOption(command, '--chat-id', args.chatId);
          this.pushOption(command, '--user-id', args.userId);
          this.pushOption(command, '--text', args.text);
          this.pushOption(command, '--idempotency-key', args.idempotencyKey);
          return command;
        },
      },
      // -------------------- 高德地图动作 --------------------
      'amap:route': {
        bin: 'amap-gui',
        requiresConfirmation: false,
        buildArgs: (args) => {
          const command = ['route'];
          this.requireArgs(action, args, ['from', 'to', 'type']);
          this.pushOption(command, '--from', args.from);
          this.pushOption(command, '--from-name', args.fromName);
          this.pushOption(command, '--to', args.to);
          this.pushOption(command, '--to-name', args.toName);
          this.pushOption(command, '--type', args.type); // driving/walking/transit等
          this.pushListOption(command, '--waypoints', args.waypoints);
          this.pushOption(command, '--policy', args.policy);
          this.pushOption(command, '--strategy', args.strategy);
          this.pushOption(command, '--city', args.city);
          return command;
        },
      },
      'amap:searchPOI': {
        bin: 'amap-gui',
        requiresConfirmation: false,
        buildArgs: (args) => {
          const command = ['searchPOI'];
          this.requireArgs(action, args, ['keyword']);
          this.pushOption(command, '--keyword', args.keyword);
          this.pushOption(command, '--city', args.city);
          this.pushOption(command, '--center', args.center);
          this.pushOption(command, '--radius', args.radius);
          this.pushOption(command, '--pageSize', args.pageSize);
          this.pushOption(command, '--pageIndex', args.pageIndex);
          return command;
        },
      },
      'amap:mapState': {
        bin: 'amap-gui',
        requiresConfirmation: false,
        buildArgs: (args) => {
          const command = ['mapState'];
          this.pushOption(command, '--action', args.action ?? 'get');
          this.pushOption(command, '--center', args.center);
          this.pushOption(command, '--zoom', args.zoom);
          this.pushOption(command, '--style', args.style);
          this.pushOption(command, '--rotation', args.rotation);
          this.pushOption(command, '--pitch', args.pitch);
          return command;
        },
      },
    };

    return specs[`${provider}:${action}`];
  }

  // ==================== 参数构造辅助函数 ====================

  /**
   * 校验必填参数
   * @param action      动作名（用于错误提示）
   * @param args        实际参数对象
   * @param names       必填参数名列表
   * @throws 如果任何一个必填参数缺失或为空，抛出错误
   */
  private requireArgs(
    action: string,
    args: Record<string, string | number | boolean | string[]>,
    names: string[],
  ) {
    for (const name of names) {
      if (
        args[name] === undefined ||
        args[name] === null ||
        args[name] === ''
      ) {
        throw new Error(`${action} 缺少必填参数: ${name}`);
      }
    }
  }

  /**
   * 将一个参数追加到目标数组，形式为 [flag, value]
   *
   * 规则：
   * - undefined / null / 空字符串 → 不追加任何东西
   * - 布尔值 true  → 只追加 flag（无值），false → 跳过
   * - 其他值       → 追加 flag 和 String(value)
   */
  private pushOption(
    target: string[],
    flag: string,
    value: string | number | boolean | string[] | undefined,
  ): string[] {
    if (value === undefined || value === null || value === '') {
      return target;
    }
    if (typeof value === 'boolean') {
      if (value) {
        target.push(flag);
      }
      return target;
    }
    target.push(flag, String(value));
    return target;
  }

  /**
   * 处理数组类型参数：先 join(',') 转为字符串，再交给 pushOption
   * 例如 --attendee-ids=id1,id2,id3
   */
  private pushListOption(
    target: string[],
    flag: string,
    value: string | number | boolean | string[] | undefined,
  ) {
    if (Array.isArray(value)) {
      this.pushOption(target, flag, value.join(','));
      return;
    }
    this.pushOption(target, flag, value);
  }

  /**
   * 处理 JSON 对象类型的参数
   * 如果 value 已经是字符串，直接传递；否则 JSON.stringify
   */
  private pushJsonOption(
    target: string[],
    flag: string,
    value: string | number | boolean | string[] | undefined,
  ) {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (typeof value === 'string') {
      target.push(flag, value);
      return;
    }
    target.push(flag, JSON.stringify(value));
  }

  // ==================== amap-gui 前置检查 ====================

  /**
   * 确保 amap-gui 服务处于就绪状态
   *
   * 执行流程：
   * 1. 调用 amap-gui status 检查状态
   * 2. 若服务正常（status=running 且 mapReady=true）→ 直接返回就绪
   * 3. 若服务异常 → 自动调用 amap-gui start 尝试启动
   * 4. 返回启动结果（是否成功 + 操作记录 notes）
   */
  private async ensureAmapGuiReady(): Promise<{
    ok: boolean;
    notes: string[];
    message?: string;
  }> {
    const notes: string[] = [];

    // 检查当前状态
    const statusResult = await this.runCommand('amap-gui', ['status']);
    if (statusResult.exitCode !== 0) {
      return {
        ok: false,
        notes,
        message: statusResult.stderr || 'amap-gui status 执行失败',
      };
    }

    // 解析 status 输出
    const parsedStatus = this.tryParseJson(statusResult.stdout) as {
      data?: { status?: string; mapReady?: boolean };
    } | null;
    const status = parsedStatus?.data?.status;
    const mapReady = parsedStatus?.data?.mapReady;

    if (status === 'running' && mapReady === true) {
      notes.push('amap-gui 已就绪');
      return { ok: true, notes };
    }

    // 状态异常，尝试自动启动
    const startResult = await this.runCommand('amap-gui', ['start']);
    if (startResult.exitCode !== 0) {
      return {
        ok: false,
        notes,
        message: startResult.stderr || 'amap-gui start 执行失败',
      };
    }

    notes.push('amap-gui 已自动启动');
    return { ok: true, notes };
  }

  // ==================== 命令执行 ====================

  /**
   * 通过 child_process.spawn 执行外部 CLI 命令
   *
   * @param bin  二进制命令名（如 lark-cli、amap-gui）
   * @param args CLI 参数列表
   * @returns    包含 exitCode、stdout、stderr 的结果对象
   *
   * 设计说明：
   * - stdio: ['ignore', 'pipe', 'pipe'] → 只捕获 stdout 和 stderr，不绑定 stdin
   * - 使用 Promise 封装 on('close') 事件，转换为 async/await 接口
   * - child.on('error') 处理命令不存在等场景，返回 exitCode=1
   */
  private runCommand(
    bin: 'lark-cli' | 'amap-gui',
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        const message =
          error instanceof Error ? error.message : 'Unknown spawn error';
        this.logger.warn(`Failed to run ${bin}: ${message}`);
        resolve({ exitCode: 1, stdout, stderr: message });
      });

      child.on('close', (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
    });
  }

  // ==================== 工具函数 ====================

  /**
   * 尝试将 stdout 解析为 JSON
   * - 如果解析成功，返回解析后的对象
   * - 如果失败（空字符串、非法 JSON），返回 null
   *
   * 用途：返回结果中同时包含原始 stdout 和 parsed（结构化）两个版本，
   *       方便 Agent 既能展示原始输出，又能进一步操作 JSON 数据
   */
  private tryParseJson(stdout: string): unknown {
    const text = stdout.trim();
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * 截断过长的文本
   *
   * @param text  原始文本
   * @returns      截断后文本（超过 6000 字符时在末尾附加 [truncated] 标记）
   *
   * 原因：CLI 输出可能非常大（数万行），直接放入 AI 上下文会浪费 token
   *       且可能超过模型输入上限。截断保证结果可控。
   */
  private truncate(text: string): string {
    const maxChars = 6000;
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n[truncated]`
      : text;
  }
}
