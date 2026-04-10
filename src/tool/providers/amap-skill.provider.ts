import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import path from 'path';
import {
  ControlledCliActionSpec,
  ControlledCliArgs,
  ControlledCliArgValue,
  SkillDocDescriptor,
  SkillDocRequest,
  SkillProvider,
} from '../skill-provider.types';

/**
 * 高德地图（amap）Skill 的提供者实现。
 * 负责将用户请求映射为 amap-gui CLI 命令，并处理执行前检查与子进程管理。
 */
@Injectable()
export class AmapSkillProvider implements SkillProvider {
  readonly id = 'amap';
  private readonly logger = new Logger(AmapSkillProvider.name);
  private readonly amapEnv: NodeJS.ProcessEnv;

  constructor(private readonly configService: ConfigService) {
    // 从环境变量或配置中读取高德地图密钥
    const amapKey =
      this.configService.get<string>('AMAP_KEY') ??
      this.configService.get<string>('AMAP_MAPS_API_KEY') ??
      '';
    const securityKey =
      this.configService.get<string>('AMAP_SECURITY_KEY') ?? '';

    // 将密钥注入环境变量，传递给子进程
    this.amapEnv = {
      ...process.env,
      AMAP_KEY: amapKey,
      AMAP_SECURITY_KEY: securityKey,
    };
    console.log('this.amapEnv',this.amapEnv);
  }

  /**
   * 规范化 Skill 名称。
   * 接受 'amap'、'amap-cli'、'amap-cli-skill'（大小写不敏感），
   * 统一映射为 'amap-cli-skill'，不支持的名称返回 null。
   */
  normalizeSkillName(skillName: string): string | null {
    const normalized = skillName.trim().toLowerCase();
    if (
      normalized === 'amap' ||
      normalized === 'amap-cli' ||
      normalized === 'amap-cli-skill'
    ) {
      return 'amap-cli-skill';
    }
    return null;
  }

  /**
   * 获取该 Skill 的主文档路径。
   * 文档固定为 {skillsRoot}/amap-cli-skill/SKILL.md。
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

  /** 该 Provider 暂不提供补充文档，返回空数组。 */
  getSupplementalDocs(): SkillDocDescriptor[] {
    return [];
  }

  /**
   * 根据 action 名称解析对应的 CLI Action 规格。
   * 支持三种 action：route（路线规划）、searchpoi（地点搜索）、mapstate（地图状态）。
   * action 名称可接受 'amap.route'、'amap-route'、'route' 等多种格式。
   */
  resolveAction(action: string): ControlledCliActionSpec | null {
    const normalizedAction = this.normalizeAction(action);
    const specs: Record<string, ControlledCliActionSpec> = {
      // 路线规划 action：将起终点、途径点、策略等参数转为 amap-gui 命令
      route: {
        bin: 'amap-gui',
        requiresConfirmation: false,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['from', 'to', 'type']);
          const command = ['route'];
          this.pushOption(command, '--from', args.from);
          this.pushOption(command, '--from-name', args.fromName);
          this.pushOption(command, '--to', args.to);
          this.pushOption(command, '--to-name', args.toName);
          this.pushOption(command, '--type', args.type);
          this.pushListOption(command, '--waypoints', args.waypoints);
          this.pushOption(command, '--policy', args.policy);
          this.pushOption(command, '--strategy', args.strategy);
          this.pushOption(command, '--city', args.city);
          return command;
        },
      },
      // 地点搜索 action：根据关键词、城市、中心点等条件搜索 POI
      searchpoi: {
        bin: 'amap-gui',
        requiresConfirmation: false,
        buildArgs: (args) => {
          this.requireArgs(normalizedAction, args, ['keyword']);
          const command = ['searchPOI'];
          this.pushOption(command, '--keyword', args.keyword);
          this.pushOption(command, '--city', args.city);
          this.pushOption(command, '--center', args.center);
          this.pushOption(command, '--radius', args.radius);
          this.pushOption(command, '--pageSize', args.pageSize);
          this.pushOption(command, '--pageIndex', args.pageIndex);
          return command;
        },
      },
      // 地图状态 action：获取或设置地图的缩放、中心点、旋转角度等状态
      mapstate: {
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

    return specs[normalizedAction] ?? null;
  }

  /** 返回携带高德密钥的环境变量，供 amap-gui 子进程使用。 */
  getExecutionEnv(): NodeJS.ProcessEnv {
    return this.amapEnv;
  }

  /**
   * 执行前检查：
   * 1. 调用 amap-gui status 检查服务是否就绪；
   * 2. 若未就绪，尝试自动启动；
   * 3. 返回检查结果及备注信息。
   */
  async preflight(): Promise<{
    ok: boolean;
    notes: string[];
    message?: string;
  }> {
    const notes: string[] = [];
    const statusResult = await this.runCommand(['status']);
    if (statusResult.exitCode !== 0) {
      return {
        ok: false,
        notes,
        message: statusResult.stderr || 'amap-gui status 执行失败',
      };
    }

    // 解析 status 返回的 JSON，判断地图服务是否已就绪
    const parsedStatus = this.tryParseJson(statusResult.stdout) as {
      data?: { status?: string; mapReady?: boolean };
    } | null;
    if (
      parsedStatus?.data?.status === 'running' &&
      parsedStatus.data.mapReady === true
    ) {
      notes.push('amap-gui 已就绪');
      return { ok: true, notes };
    }

    // 若未就绪，尝试自动启动
    const startResult = await this.runCommand(['start']);
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

  /**
   * 规范化 action 名称：
   * 去除前缀 'amap.'（若有），再统一去除 '.'、'-'、'_' 并转为小写。
   * 例如：'amap.route'、'amap-route'、'route' 均被规范为 'route'。
   */
  private normalizeAction(action: string): string {
    const raw = action.trim();
    if (!raw) {
      return '';
    }

    const stripped = raw.startsWith('amap.') ? raw.slice(5) : raw;
    return stripped.replace(/[.\-_]/g, '').toLowerCase();
  }

  /** 检查必填参数是否缺失，缺失则抛出错误。 */
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
   * 将单个选项参数（flag + value）追加到命令数组。
   * - boolean true：仅追加 flag（作为开关）；
   * - 其他类型：追加 flag 和对应的字符串值；
   * - undefined / null / 空字符串：忽略。
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
   * 将列表类型选项追加到命令数组。
   * 数组值会被 join 为逗号分隔的字符串后追加。
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
   * 使用 spawn 异步执行 amap-gui 命令，
   * 返回 { exitCode, stdout, stderr }。
   */
  private runCommand(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('amap-gui', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.amapEnv,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        const message =
          error instanceof Error ? error.message : 'Unknown spawn error';
        this.logger.warn(`Failed to run amap-gui: ${message}`);
        resolve({ exitCode: 1, stdout, stderr: message });
      });

      child.on('close', (code) => {
        resolve({ exitCode: code ?? 0, stdout, stderr });
      });
    });
  }

  /** 安全地尝试解析 JSON，若解析失败返回 null。 */
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
}
