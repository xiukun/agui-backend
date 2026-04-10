// CLI 参数值的合法类型，支持字符串、数字、布尔、字符串数组、对象及未知数组
export type ControlledCliArgValue =
  | string
  | number
  | boolean
  | string[]
  | Record<string, unknown>
  | unknown[];

// CLI 参数集合，键为参数名，值为参数值
export type ControlledCliArgs = Record<string, ControlledCliArgValue>;

// CLI Action 的规格定义，描述如何执行一个 CLI 命令
export type ControlledCliActionSpec = {
  bin: string; // CLI 可执行文件的名称或路径
  requiresConfirmation: boolean; // 执行前是否需要用户确认
  buildArgs: (args: ControlledCliArgs) => string[]; // 根据传入参数构建完整的命令行参数列表
};

// 请求获取某个 Skill 文档的描述符
export type SkillDocRequest = {
  skillName: string; // Skill 名称
  includeShared?: boolean; // 是否包含共享文档，默认为 false
};

// Skill 文档的描述符，用于定位具体的文档资源
export type SkillDocDescriptor = {
  skillName: string; // 对应的 Skill 名称
  filePath: string; // 文档文件的绝对或相对路径
  fileLabel: string; // 文档的展示标签
};

// Skill 提供者的核心接口，封装 Skill 的发现、文档解析和执行逻辑
export type SkillProvider = {
  readonly id: string; // 提供者的唯一标识符
  normalizeSkillName: (skillName: string) => string | null; // 规范化 Skill 名称，返回规范名或 null（若不支持）
  getPrimaryDoc: (
    skillsRoot: string,
    request: SkillDocRequest,
  ) => SkillDocDescriptor | null; // 获取该 Skill 的主文档描述符，若无则返回 null
  getSupplementalDocs: (
    skillsRoot: string,
    request: SkillDocRequest,
  ) => SkillDocDescriptor[]; // 获取该 Skill 的补充文档列表（如使用指南、配置说明等）
  resolveAction: (action: string) => ControlledCliActionSpec | null; // 根据 action 名称解析对应的 CLI Action 规格，若不支持该 action 则返回 null
  getExecutionEnv?: () => NodeJS.ProcessEnv | undefined; // 可选，获取执行时的环境变量
  preflight?: () => Promise<{ ok: boolean; notes: string[]; message?: string }>; // 可选，执行前检查（如检查依赖、权限等），返回检查结果及备注信息
};