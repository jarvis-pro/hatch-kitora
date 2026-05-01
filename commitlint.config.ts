import type { UserConfig } from '@commitlint/types';

/**
 * Conventional Commits 校验
 * 允许中文描述，限制 type 在常用集合内
 */
const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新功能
        'fix', // 修复 bug
        'refactor', // 重构（不改变功能）
        'perf', // 性能优化
        'style', // 样式 / 格式
        'test', // 测试
        'docs', // 文档
        'build', // 构建系统 / 外部依赖
        'ci', // CI 配置
        'chore', // 杂项 / 工具配置
        'revert', // 回滚
      ],
    ],
    // 中文 subject 通常会触发 case 检查，放宽
    'subject-case': [0],
    // 末尾不强制句号
    'subject-full-stop': [2, 'never', '.'],
    // 单行长度上限 100，给中文留点余地
    'header-max-length': [2, 'always', 100],
  },
};

export default config;
