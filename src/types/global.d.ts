/// <reference types="next-auth" />

/**
 * 全局类型声明文件。
 *
 * 扩展 Node.js 进程环境类型，确保 TypeScript 类型检查能识别 NODE_ENV 环境变量。
 */
declare global {
  namespace NodeJS {
    /**
     * Node.js 进程环境变量接口扩展。
     *
     * 定义应用支持的部署和执行环境。
     */
    interface ProcessEnv {
      /**
       * 当前运行环境。
       * - 'development' — 本地开发模式
       * - 'production' — 生产环境
       * - 'test' — 测试或 CI 环境
       */
      readonly NODE_ENV: 'development' | 'production' | 'test';
    }
  }
}

export {};
