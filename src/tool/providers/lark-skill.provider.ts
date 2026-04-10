import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import {
  ControlledCliActionSpec,
  ControlledCliArgValue,
  ControlledCliArgs,
  SkillDocDescriptor,
  SkillDocRequest,
  SkillProvider,
} from '../skill-provider.types';

/**
 * 飞书（Lark）相关命令的 Skill 提供者。
 * 将高层的 action（如 calendar.agenda、doc.search 等）映射为 lark-cli 的具体命令与参数。
 */
@Injectable()
export class LarkSkillProvider implements SkillProvider {
  readonly id = 'lark';
  private readonly larkEnv: NodeJS.ProcessEnv;

  constructor(private readonly configService: ConfigService) {
    const appId = this.configService.get<string>('FEISHU_APP_ID') ?? '';
    const appSecret = this.configService.get<string>('FEISHU_APP_SECRET') ?? '';
    this.larkEnv = {
      ...process.env,
      FEISHU_APP_ID: appId,
      FEISHU_APP_SECRET: appSecret,
    };
  }

  /**
   * 将 .env 中的飞书应用凭证注入子进程，供 lark-cli 使用（与 AmapSkillProvider 的密钥注入方式一致）。
   */
  getExecutionEnv(): NodeJS.ProcessEnv {
    return this.larkEnv;
  }

  /**
   * 执行前校验：未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 时拒绝执行，避免静默失败。
   */
  async preflight(): Promise<{
    ok: boolean;
    notes: string[];
    message?: string;
  }> {
    const appId = this.configService.get<string>('FEISHU_APP_ID') ?? '';
    const appSecret = this.configService.get<string>('FEISHU_APP_SECRET') ?? '';
    if (!appId.trim() || !appSecret.trim()) {
      return {
        ok: false,
        notes: [],
        message:
          '缺少飞书应用凭证：请在 .env 中配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET',
      };
    }
    return {
      ok: true,
      notes: ['已注入 FEISHU_APP_ID / FEISHU_APP_SECRET 至 lark-cli 环境'],
    };
  }

  /**
   * 规范化 Skill 名称：将用户输入的别名映射到具体的技能目录名。
   * 例如：'doc'/'docs' -> 'lark-doc'，'calendar' -> 'lark-calendar'。
   */
  normalizeSkillName(skillName: string): string | null {
    const normalized = skillName.trim().toLowerCase();
    const aliases: Record<string, string> = {
      lark: 'lark-shared',
      'lark-shared': 'lark-shared',
      calendar: 'lark-calendar',
      'lark-calendar': 'lark-calendar',
      contact: 'lark-contact',
      'lark-contact': 'lark-contact',
      doc: 'lark-doc',
      docs: 'lark-doc',
      'lark-doc': 'lark-doc',
      im: 'lark-im',
      'lark-im': 'lark-im',
      base: 'lark-base',
      'lark-base': 'lark-base',
    };

    return aliases[normalized] ?? null;
  }

  /**
   * 获取主文档：返回目标 Skill 目录下的 SKILL.md。
   */
  getPrimaryDoc(
    skillsRoot: string,
    request: SkillDocRequest,
  ): SkillDocDescriptor | null {
    const normalized = this.normalizeSkillName(request.skillName);
    if (!normalized) {
      return null;
    }
    return {
      skillName: normalized,
      filePath: path.join(skillsRoot, normalized, 'SKILL.md'),
      fileLabel: 'SKILL.md',
    };
  }

  /**
   * 获取补充文档：当请求的 Skill 不是 lark-shared 且 includeShared=true 时，
   * 追加返回 lark-shared 的 SKILL.md 作为共享说明。
   */
  getSupplementalDocs(
    skillsRoot: string,
    request: SkillDocRequest,
  ): SkillDocDescriptor[] {
    const normalized = this.normalizeSkillName(request.skillName);
    if (!request.includeShared || !normalized || normalized === 'lark-shared') {
      return [];
    }

    return [
      {
        skillName: 'lark-shared',
        filePath: path.join(skillsRoot, 'lark-shared', 'SKILL.md'),
        fileLabel: 'SKILL.md',
      },
    ];
  }

  /**
   * 解析 action 并返回对应的 lark-cli 执行规格。
   * 支持 calendar/contact/doc/im/base 等子域的多种操作。
   */
  resolveAction(action: string): ControlledCliActionSpec | null {
    const normalizedAction = this.normalizeAction(action);
    const specs: Record<string, ControlledCliActionSpec> = {
      // 日历：获取时间段内的日程摘要
      'calendar.agenda': {
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
      // 日历：创建日程
      'calendar.create': {
        bin: 'lark-cli',
        requiresConfirmation: true,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['start', 'end']);
          const command = ['calendar', '+create'];
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
      // 通讯录：搜索用户
      'contact.search-user': {
        bin: 'lark-cli',
        requiresConfirmation: false,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['query']);
          const command = ['contact', '+search-user'];
          this.pushOption(command, '--query', args.query);
          this.pushOption(command, '--page-size', args.pageSize);
          this.pushOption(command, '--page-token', args.pageToken);
          this.pushOption(command, '--format', args.format);
          return command;
        },
      },
      // 文档：搜索
      'doc.search': {
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
      // 文档：获取内容
      'doc.fetch': {
        bin: 'lark-cli',
        requiresConfirmation: false,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['doc']);
          const command = ['docs', '+fetch'];
          this.pushOption(command, '--doc', args.doc);
          this.pushOption(command, '--offset', args.offset);
          this.pushOption(command, '--limit', args.limit);
          this.pushOption(command, '--format', args.format);
          return command;
        },
      },
      // 文档：创建
      'doc.create': {
        bin: 'lark-cli',
        requiresConfirmation: true,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['title', 'content']);
          const command = ['docs', '+create'];
          this.pushOption(command, '--title', args.title);
          this.pushOption(command, '--content', args.content);
          this.pushOption(command, '--parent-token', args.parentToken);
          this.pushOption(command, '--parent-type', args.parentType);
          return command;
        },
      },
      // 文档：更新
      'doc.update': {
        bin: 'lark-cli',
        requiresConfirmation: true,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['doc', 'mode']);
          const command = ['docs', '+update'];
          this.pushOption(command, '--doc', args.doc);
          this.pushOption(command, '--mode', args.mode);
          this.pushOption(command, '--markdown', args.markdown);
          this.pushOption(
            command,
            '--selection-with-ellipsis',
            args.selectionWithEllipsis,
          );
          this.pushOption(
            command,
            '--selection-by-title',
            args.selectionByTitle,
          );
          return command;
        },
      },
      // 即时消息：发送文本消息
      'im.send': {
        bin: 'lark-cli',
        requiresConfirmation: true,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['text']);
          if (!args.chatId && !args.userId) {
            throw new Error('im.send 需要 chatId 或 userId 其中之一');
          }
          const command = ['im', '+messages-send', '--as', 'bot'];
          this.pushOption(command, '--chat-id', args.chatId);
          this.pushOption(command, '--user-id', args.userId);
          this.pushOption(command, '--text', args.text);
          this.pushOption(command, '--idempotency-key', args.idempotencyKey);
          return command;
        },
      },
      // Base：读取与写入相关操作（封装成工厂方法）
      'base.base-get': this.makeBaseReadAction('+base-get', ['baseToken'], {
        baseToken: '--base-token',
        format: '--format',
      }),
      'base.table-list': this.makeBaseReadAction('+table-list', ['baseToken'], {
        baseToken: '--base-token',
        format: '--format',
      }),
      'base.table-get': this.makeBaseReadAction(
        '+table-get',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          format: '--format',
        },
      ),
      'base.field-list': this.makeBaseReadAction(
        '+field-list',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          format: '--format',
        },
      ),
      'base.field-get': this.makeBaseReadAction(
        '+field-get',
        ['baseToken', 'tableId', 'fieldId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          fieldId: '--field-id',
          format: '--format',
        },
      ),
      'base.record-list': this.makeBaseReadAction(
        '+record-list',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          sortBy: '--sort-by',
          filter: '--filter',
          pageSize: '--page-size',
          pageToken: '--page-token',
          format: '--format',
        },
      ),
      'base.record-get': this.makeBaseReadAction(
        '+record-get',
        ['baseToken', 'tableId', 'recordId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          recordId: '--record-id',
          format: '--format',
        },
      ),
      'base.view-list': this.makeBaseReadAction(
        '+view-list',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          offset: '--offset',
          limit: '--limit',
          format: '--format',
        },
      ),
      'base.form-list': this.makeBaseReadAction(
        '+form-list',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          format: '--format',
        },
      ),
      'base.dashboard-list': this.makeBaseReadAction(
        '+dashboard-list',
        ['baseToken'],
        {
          baseToken: '--base-token',
          pageSize: '--page-size',
          pageToken: '--page-token',
          format: '--format',
        },
      ),
      'base.data-query': this.makeBaseReadAction(
        '+data-query',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          filter: '--filter',
          pageSize: '--page-size',
          pageToken: '--page-token',
          format: '--format',
        },
      ),
      'base.role-list': this.makeBaseReadAction('+role-list', ['baseToken'], {
        baseToken: '--base-token',
        format: '--format',
      }),
      'base.record-history-list': this.makeBaseReadAction(
        '+record-history-list',
        ['baseToken', 'tableId', 'recordId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          recordId: '--record-id',
          format: '--format',
        },
      ),
      'base.table-create': this.makeBaseWriteAction(
        '+table-create',
        ['baseToken', 'name'],
        {
          baseToken: '--base-token',
          name: '--name',
          fields: '--fields',
          view: '--view',
        },
      ),
      'base.table-update': this.makeBaseWriteAction(
        '+table-update',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          name: '--name',
        },
      ),
      'base.table-delete': this.makeBaseWriteAction(
        '+table-delete',
        ['baseToken', 'tableId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
        },
      ),
      'base.field-create': this.makeBaseWriteAction(
        '+field-create',
        ['baseToken', 'tableId', 'json'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          json: '--json',
        },
      ),
      'base.field-update': this.makeBaseWriteAction(
        '+field-update',
        ['baseToken', 'tableId', 'fieldId', 'json'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          fieldId: '--field-id',
          json: '--json',
        },
      ),
      'base.field-delete': this.makeBaseWriteAction(
        '+field-delete',
        ['baseToken', 'tableId', 'fieldId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          fieldId: '--field-id',
        },
      ),
      'base.record-upsert': this.makeBaseWriteAction(
        '+record-upsert',
        ['baseToken', 'tableId', 'json'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          recordId: '--record-id',
          json: '--json',
        },
      ),
      'base.record-delete': this.makeBaseWriteAction(
        '+record-delete',
        ['baseToken', 'tableId', 'recordId'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          recordId: '--record-id',
        },
      ),
      'base.view-create': this.makeBaseWriteAction(
        '+view-create',
        ['baseToken', 'tableId', 'name', 'type'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          name: '--name',
          type: '--type',
        },
      ),
      'base.view-rename': this.makeBaseWriteAction(
        '+view-rename',
        ['baseToken', 'tableId', 'viewId', 'name'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          viewId: '--view-id',
          name: '--name',
        },
      ),
      'base.view-set-filter': this.makeBaseWriteAction(
        '+view-set-filter',
        ['baseToken', 'tableId', 'viewId', 'filter'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          viewId: '--view-id',
          filter: '--filter',
        },
      ),
      'base.view-set-sort': this.makeBaseWriteAction(
        '+view-set-sort',
        ['baseToken', 'tableId', 'viewId', 'sort'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          viewId: '--view-id',
          sort: '--sort',
        },
      ),
      'base.view-set-group': this.makeBaseWriteAction(
        '+view-set-group',
        ['baseToken', 'tableId', 'viewId', 'group'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          viewId: '--view-id',
          group: '--group',
        },
      ),
      'base.dashboard-create': this.makeBaseWriteAction(
        '+dashboard-create',
        ['baseToken', 'name'],
        {
          baseToken: '--base-token',
          name: '--name',
        },
      ),
      'base.dashboard-update': this.makeBaseWriteAction(
        '+dashboard-update',
        ['baseToken', 'dashboardId'],
        {
          baseToken: '--base-token',
          dashboardId: '--dashboard-id',
          name: '--name',
        },
      ),
      'base.form-create': this.makeBaseWriteAction(
        '+form-create',
        ['baseToken', 'tableId', 'name'],
        {
          baseToken: '--base-token',
          tableId: '--table-id',
          name: '--name',
          description: '--description',
        },
      ),
      'base.form-update': this.makeBaseWriteAction(
        '+form-update',
        ['baseToken', 'formId'],
        {
          baseToken: '--base-token',
          formId: '--form-id',
          name: '--name',
          description: '--description',
        },
      ),
      'base.workflow-enable': this.makeBaseWriteAction(
        '+workflow-enable',
        ['baseToken', 'workflowId'],
        {
          baseToken: '--base-token',
          workflowId: '--workflow-id',
        },
      ),
      'base.workflow-disable': this.makeBaseWriteAction(
        '+workflow-disable',
        ['baseToken', 'workflowId'],
        {
          baseToken: '--base-token',
          workflowId: '--workflow-id',
        },
      ),
      'base.role-create': this.makeBaseWriteAction(
        '+role-create',
        ['baseToken', 'roleName', 'json'],
        {
          baseToken: '--base-token',
          roleName: '--role-name',
          json: '--json',
        },
      ),
      'base.role-update': this.makeBaseWriteAction(
        '+role-update',
        ['baseToken', 'roleId', 'json'],
        {
          baseToken: '--base-token',
          roleId: '--role-id',
          json: '--json',
        },
      ),
    };

    return specs[normalizedAction] ?? null;
  }

  /**
   * 规范化 action：去除前缀 'lark.'，其余保持不变，便于字典查找。
   */
  private normalizeAction(action: string): string {
    const raw = action.trim();
    if (!raw) {
      return '';
    }
    if (raw.startsWith('lark.')) {
      return raw.slice(5);
    }
    return raw;
  }

  /**
   * Base 读取操作的工厂：统一构建只读命令规格。
   */
  private makeBaseReadAction(
    shortcut: string,
    requiredArgs: string[],
    argMap: Record<string, string>,
  ): ControlledCliActionSpec {
    return {
      bin: 'lark-cli',
      requiresConfirmation: false,
      buildArgs: (args) =>
        this.buildBaseCommand(shortcut, requiredArgs, argMap, args),
    };
  }

  /**
   * Base 写入操作的工厂：统一构建需要确认的命令规格。
   */
  private makeBaseWriteAction(
    shortcut: string,
    requiredArgs: string[],
    argMap: Record<string, string>,
  ): ControlledCliActionSpec {
    return {
      bin: 'lark-cli',
      requiresConfirmation: true,
      buildArgs: (args) =>
        this.buildBaseCommand(shortcut, requiredArgs, argMap, args),
    };
  }

  /**
   * 组装 Base 命令：按入参与映射表追加参数。
   * 针对需要 JSON 格式的参数（fields/view/json/filter/sort/group），使用 pushJsonOption。
   */
  private buildBaseCommand(
    shortcut: string,
    requiredArgs: string[],
    argMap: Record<string, string>,
    args: ControlledCliArgs,
  ): string[] {
    this.requireArgs(shortcut, args, requiredArgs);
    const command = ['base', shortcut];
    for (const [argName, flag] of Object.entries(argMap)) {
      const value = args[argName];
      if (argName === 'fields' || argName === 'view' || argName === 'json') {
        this.pushJsonOption(command, flag, value);
      } else if (
        argName === 'filter' ||
        argName === 'sort' ||
        argName === 'group'
      ) {
        this.pushJsonOption(command, flag, value);
      } else {
        this.pushOption(command, flag, value);
      }
    }
    return command;
  }

  /**
   * 校验必填参数：若缺失则抛出错误。
   */
  private requireArgs(
    action: string,
    args: ControlledCliArgs,
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
   * 追加通用选项：
   * - boolean true 仅追加 flag；
   * - 其它类型追加 flag 与字符串化的值；
   * - 空值跳过。
   */
  private pushOption(
    target: string[],
    flag: string,
    value: ControlledCliArgValue | undefined,
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
    if (typeof value === 'object' && value !== null) {
      target.push(flag, JSON.stringify(value));
    } else {
      target.push(flag, String(value));
    }
    return target;
  }

  /**
   * 追加列表选项：数组值以逗号拼接后追加。
   */
  private pushListOption(
    target: string[],
    flag: string,
    value: ControlledCliArgValue | undefined,
  ) {
    if (Array.isArray(value)) {
      target.push(flag, value.map((item) => String(item)).join(','));
      return;
    }
    this.pushOption(target, flag, value);
  }

  /**
   * 追加 JSON 类型选项：
   * - 字符串按原样追加；
   * - 其它类型通过 JSON.stringify 序列化后追加。
   */
  private pushJsonOption(
    target: string[],
    flag: string,
    value: ControlledCliArgValue | undefined,
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
}
