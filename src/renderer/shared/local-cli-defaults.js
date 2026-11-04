// Default external-Agent seeds shared by Main and Renderer. No runtime state.
(function () {
  const defaults = {
    claude: {
      name: 'ClaudeCode',
      description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
      description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
      isCoding: true,
    },
    codex: {
      name: 'Codex',
      description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
      description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
      isCoding: true,
    },
    openclaw: {
      name: 'OpenClaw',
      description_zh: '协助处理日常事务，包括查找资料、撰写内容、整理文件和执行自动化任务，提供所需内容及处理结果。',
      description_en: 'Helps with everyday tasks, including finding information, writing content, organizing files, and running automated tasks, providing the requested content and results.',
      isCoding: false,
    },
    opencode: {
      name: 'OpenCode',
      description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
      description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
      isCoding: true,
    },
    hermes: {
      name: 'Hermes',
      description_zh: '完成资料研究、代码开发和需要多个步骤的任务，提供研究结论、代码修改或生成的文件。',
      description_en: 'Carries out research, code development, and tasks that require multiple steps, providing research findings, code changes, or generated files.',
      isCoding: false,
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = defaults;
  if (typeof window !== 'undefined') window.LOCAL_CLI_DEFAULTS = defaults;
})();
