import { Injectable } from '@nestjs/common';
import { AmapSkillProvider } from './providers/amap-skill.provider';
import { LarkSkillProvider } from './providers/lark-skill.provider';
import {
  ControlledCliActionSpec,
  SkillDocDescriptor,
  SkillDocRequest,
  SkillProvider,
} from './skill-provider.types';

/**
 * Skill 提供者的注册中心。
 * 负责统一调度 AmapSkillProvider 和 LarkSkillProvider，
 * 提供文档解析（resolveSkillDocs）和 Action 解析（resolveAction）两个核心入口。
 */
@Injectable()
export class SkillProviderRegistry {
  private readonly providers: SkillProvider[];

  constructor(
    private readonly amapProvider: AmapSkillProvider,
    private readonly larkProvider: LarkSkillProvider,
  ) {
    // 按优先级顺序注册 Provider（先注册的优先匹配）
    this.providers = [this.amapProvider, this.larkProvider];
  }

  /**
   * 根据请求解析 Skill 文档列表。
   * 遍历所有 Provider，找到第一个匹配的返回其主文档和补充文档；
   * 若均不匹配，则构造一个基于 skillsRoot 的默认路径返回。
   */
  resolveSkillDocs(
    skillsRoot: string,
    request: SkillDocRequest,
  ): SkillDocDescriptor[] {
    for (const provider of this.providers) {
      const primary = provider.getPrimaryDoc(skillsRoot, request);
      if (!primary) {
        continue;
      }
      return [primary, ...provider.getSupplementalDocs(skillsRoot, request)];
    }

    return [
      {
        skillName: request.skillName.trim(),
        filePath: `${skillsRoot}/${request.skillName.trim()}/SKILL.md`,
        fileLabel: 'SKILL.md',
      },
    ];
  }

  /**
   * 根据 Provider ID 和 Action 名称解析对应的执行规格。
   * 返回匹配的 Provider 实例及其 ControlledCliActionSpec；
   * 若 Provider 不存在或 Action 不被支持，返回 null。
   */
  resolveAction(
    providerId: string,
    action: string,
  ): { provider: SkillProvider; spec: ControlledCliActionSpec } | null {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) {
      return null;
    }

    const spec = provider.resolveAction(action);
    if (!spec) {
      return null;
    }

    return { provider, spec };
  }
}
