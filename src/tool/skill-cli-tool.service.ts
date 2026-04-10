import { Injectable, Logger } from '@nestjs/common';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'child_process';
import { SkillProviderRegistry } from './skill-provider.registry';
import {
  ControlledCliArgs,
  ControlledCliArgValue,
} from './skill-provider.types';

@Injectable()
export class CliToolService {
  private readonly logger = new Logger(CliToolService.name);

  readonly tool: StructuredToolInterface;

  constructor(private readonly skillProviderRegistry: SkillProviderRegistry) {
    const controlledCliArgsSchema = z.object({
      provider: z
        .enum(['lark', 'amap'])
        .describe('命令提供方。当前支持 lark 和 amap。'),
      action: z
        .string()
        .describe(
          'provider 下的注册动作名（勿臆造）。飞书示例：base.base-get、base.table-get、base.record-list、config.show；高德：route、searchPOI。错误示例：lark.base.get、base.get、config.list（应分别为 base.base-get、config.show）。',
        ),
      args: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.string()),
            z.record(z.string(), z.unknown()),
            z.array(z.unknown()),
          ]),
        )
        .optional()
        .describe('结构化参数对象，由 provider 内部转换为 CLI flags。'),
      confirmWrite: z
        .boolean()
        .optional()
        .describe('写操作确认开关。所有写动作必须显式传 true。'),
      dryRun: z.boolean().optional().describe('是否附加 --dry-run。'),
    });

    this.tool = tool(
      async ({
        provider,
        action,
        args,
        confirmWrite,
        dryRun,
      }: {
        provider: 'lark' | 'amap';
        action: string;
        args?: ControlledCliArgs;
        confirmWrite?: boolean;
        dryRun?: boolean;
      }) => {
        const resolved = this.skillProviderRegistry.resolveAction(
          provider,
          action,
        );
        if (!resolved) {
          return `不支持的受控动作: ${provider}.${action}`;
        }

        const { provider: providerImpl, spec } = resolved;
        const finalArgs = spec.buildArgs(args ?? {});

        if (dryRun) {
          finalArgs.push('--dry-run');
        }

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

        const preflightNotes: string[] = [];
        if (providerImpl.preflight) {
          const preflight = await providerImpl.preflight();
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

        const execResult = await this.runCommand(
          spec.bin,
          finalArgs,
          providerImpl.getExecutionEnv?.(),
        );
        const parsed = this.tryParseJson(execResult.stdout);

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
            parsed,
          },
          null,
          2,
        );
      },
      {
        name: 'exec_controlled_cli',
        description:
          '执行 provider registry 注册的受控 CLI 动作。只接受结构化参数，不接受自由文本命令；写操作必须显式 confirmWrite=true。',
        schema: controlledCliArgsSchema,
      },
    );
  }

  private runCommand(
    bin: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
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

  private truncate(text: string): string {
    const maxChars = 6000;
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n[truncated]`
      : text;
  }
}
