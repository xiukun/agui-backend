import os from 'os';
import { StructuredToolInterface } from '@langchain/core/tools';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class McpToolService implements OnModuleDestroy {
  private readonly logger = new Logger(McpToolService.name);
  private readonly mcpClient: MultiServerMCPClient;
  private toolsPromise?: Promise<StructuredToolInterface[]>;

  constructor(private readonly configService: ConfigService) {
    const mcpServers: Record<string, any> = {
      filesystem: {
        command: 'npx',
        args: [
          '-y',
          '@modelcontextprotocol/server-filesystem',
          ...this.getAllowedPaths(),
        ],
      },
    };

    const amapKey = this.configService.get<string>('AMAP_MAPS_API_KEY');
    if (amapKey) {
      mcpServers['amap-maps-streamableHTTP'] = {
        url: `https://mcp.amap.com/mcp?key=${amapKey}`,
      };
    } else {
      this.logger.warn(
        'AMAP_MAPS_API_KEY is missing, amap MCP server is disabled.',
      );
    }

    this.mcpClient = new MultiServerMCPClient({ mcpServers });
  }

  async getTools(): Promise<StructuredToolInterface[]> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.mcpClient
        .getTools()
        .then((tools) => {
          this.logger.log(`Loaded ${tools.length} MCP tool(s).`);
          // Wrap tools so downstream agent gets a useful error message instead of
          // a generic "Failed to fetch".
          return tools.map((t) => this.wrapTool(t));
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(`Failed to load MCP tools: ${reason}`);
          return [];
        });
    }

    return this.toolsPromise;
  }

  async onModuleDestroy() {
    await this.mcpClient.close().catch(() => undefined);
  }

  private getAllowedPaths(): string[] {
    const rawPaths = this.configService.get<string>('ALLOWED_PATHS');
    const envPaths = rawPaths
      ? rawPaths
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
    return Array.from(new Set([os.homedir(), ...envPaths]));
  }

  private wrapTool(t: StructuredToolInterface): StructuredToolInterface {
    const originalInvoke = t.invoke.bind(t) as (
      ...invokeArgs: unknown[]
    ) => Promise<unknown>;

    const wrapped = Object.assign(Object.create(Object.getPrototypeOf(t)), t, {
      invoke: async (...invokeArgs: unknown[]) => {
        try {
          return await originalInvoke(...invokeArgs);
        } catch (error: unknown) {
          return this.formatInvokeError(t.name, error);
        }
      },
    });

    return wrapped as StructuredToolInterface;
  }

  private formatInvokeError(toolName: string, error: unknown): string {
    // Best-effort extraction of nested fetch/network errors (undici often sets `cause`)
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);

    const cause =
      error && typeof error === 'object' && 'cause' in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const causeCode =
      cause && typeof cause === 'object' && 'code' in cause
        ? typeof (cause as { code?: unknown }).code === 'string'
          ? String((cause as { code: string }).code)
          : undefined
        : undefined;
    const causeMsg =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : cause
            ? JSON.stringify(cause)
            : undefined;

    const details = [
      message ? `message=${message}` : undefined,
      causeCode ? `cause.code=${causeCode}` : undefined,
      causeMsg ? `cause.message=${causeMsg}` : undefined,
    ]
      .filter(Boolean)
      .join(' | ');

    return [
      `MCP tool invoke failed: ${toolName}`,
      details ? `details: ${details}` : undefined,
      'hint: this is usually a network/DNS/proxy issue (server cannot reach the MCP host).',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
