import { Injectable, Logger } from '@nestjs/common';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * LarkSkillLoaderToolService
 *
 * 职责：按需加载本地 skill 说明文档，供 AI Agent 在执行飞书/高德命令前
 * 理解各 skill 的规则、参数格式和安全约束。
 *
 * 核心思路：Agent 不需要每次都加载完整 skill 文档，只在需要时通过
 * load_local_skill 工具指定加载哪些 skill，实现"懒加载 + 按需引用"。
 *
 * 安全设计：
 * - 所有路径操作被限制在 skills/ 目录内（resolveInsideSkillsRoot 做 path traversal 检查）
 * - referenceFiles 最多 3 个，避免一次读取过多文件
 * - 单个文件内容超过 6000 字符时截断
 *
 * 目录结构约定（skillsRoot = 项目根目录/skills）：
 *   skills/
 *   ├── lark-calendar/
 *   │   ├── SKILL.md           ← 必须：描述 skill 的作用和使用方式
 *   │   └── references/        ← 可选：存放参考文档
 *   │       └── lark-calendar-create.md
 *   ├── lark-task/
 *   └── lark-shared/
 *       └── SKILL.md           ← 当 includeShared=true 时额外加载
 */
@Injectable()
export class LarkSkillLoaderToolService {
  private readonly logger = new Logger(LarkSkillLoaderToolService.name);
  /**
   * skills 根目录，固定为 {项目根目录}/skills
   * process.cwd() 返回启动服务时的工作目录
   */
  private readonly skillsRoot = path.join(process.cwd(), 'skills');

  /** LangChain StructuredTool 实例，对外暴露给 Agent 调用 */
  readonly tool: StructuredToolInterface;

  constructor() {
    // --- 工具入参 Schema 定义 ---
    const loadArgsSchema = z.object({
      skillName: z
        .string()
        .describe(
          '本地 skill 目录名，例如 amap-cli-skill、lark-calendar、lark-task。',
        ),
      includeShared: z
        .boolean()
        .optional()
        .describe('当 skill 为 lark-* 时，是否额外加载 lark-shared/SKILL.md。'),
      referenceFiles: z
        .array(z.string())
        .max(3)
        .optional()
        .describe(
          '要附带加载的参考文档文件名列表，仅支持当前 skill 的 references/ 目录，例如 ["lark-calendar-create.md"]。',
        ),
    });

    this.tool = tool(
      /**
       * 工具执行函数：读取指定 skill 的文档内容并拼接返回
       *
       * @param skillName        要加载的 skill 目录名（如 lark-calendar）
       * @param includeShared    是否同时加载 lark-shared/SKILL.md（共享规则）
       * @param referenceFiles    references/ 目录下要额外加载的文档（最多3个）
       */
      async ({
        skillName,
        includeShared,
        referenceFiles,
      }: {
        skillName: string;
        includeShared?: boolean;
        referenceFiles?: string[];
      }) => {
        // 安全校验：skillName 不能为空
        const normalized = skillName.trim();
        if (!normalized) {
          return 'skillName 不能为空';
        }

        try {
          const sections: string[] = [];

          // 1. 加载主 SKILL.md（必选）
          const skillDir = this.resolveInsideSkillsRoot(normalized);
          const skillDocPath = path.join(skillDir, 'SKILL.md');
          const skillDoc = await fs.readFile(skillDocPath, 'utf8');
          sections.push(this.formatSection(normalized, 'SKILL.md', skillDoc));

          // 2. 如果是 lark-* skill 且 includeShared=true，额外加载共享规则
          if (includeShared && normalized.startsWith('lark-')) {
            const sharedPath = path.join(
              this.skillsRoot,
              'lark-shared',
              'SKILL.md',
            );
            const sharedDoc = await fs.readFile(sharedPath, 'utf8');
            sections.push(
              this.formatSection('lark-shared', 'SKILL.md', sharedDoc),
            );
          }

          // 3. 加载 references/ 目录下的参考文档（最多 3 个）
          for (const fileName of referenceFiles ?? []) {
            // path.basename 防止路径穿越，例如 fileName = "../../../etc/passwd"
            const safeName = path.basename(fileName);
            const referencePath = path.join(skillDir, 'references', safeName);
            const referenceDoc = await fs.readFile(referencePath, 'utf8');
            sections.push(
              this.formatSection(
                normalized,
                `references/${safeName}`,
                referenceDoc,
              ),
            );
          }

          // 将所有章节用空行拼接成最终返回文本
          return sections.join('\n\n');
        } catch (e) {
          this.logger.warn(
            `Failed to load local skill ${normalized}: ${(e as Error).message}`,
          );
          return `未找到本地 skill 或参考文档：${normalized}`;
        }
      },
      {
        name: 'load_local_skill',
        description:
          '按需读取当前仓库 skills/ 目录下的本地 skill 说明与参考文档。优先用于在执行 amap 或 lark 命令前理解规则、参数和安全约束。',
        schema: loadArgsSchema,
      },
    );
  }

  /**
   * 路径安全校验：确保最终解析的路径仍在 skillsRoot 下
   *
   * 防止 path traversal 攻击，例如 skillName = "../../../etc/passwd"
   * 会企图读取 skillsRoot 之外的文件。此函数会在越界时抛错。
   *
   * 原理：path.resolve 会把相对路径转为绝对路径，然后检查是否以
   * skillsRoot + path.sep 为前缀。如果不是，说明穿越到了目录外。
   */
  private resolveInsideSkillsRoot(skillName: string): string {
    const target = path.resolve(this.skillsRoot, skillName);
    if (!target.startsWith(this.skillsRoot + path.sep)) {
      throw new Error(`Invalid skill path: ${skillName}`);
    }
    return target;
  }

  /**
   * 将文档格式化为统一 Markdown 格式的章节
   *
   * @param skillName  skill 名称
   * @param fileName   文件名（含路径部分）
   * @param content    文件原始内容
   * @returns          格式化后的 Markdown 字符串
   *
   * 超过 6000 字符的内容会被截断，防止单个超大文件撑爆上下文窗口
   */
  private formatSection(
    skillName: string,
    fileName: string,
    content: string,
  ): string {
    const maxChars = 6000;
    const body =
      content.length > maxChars
        ? `${content.slice(0, maxChars)}\n\n[truncated]`
        : content;
    return `## ${skillName}/${fileName}\n\n${body}`;
  }
}
