/**
 * Node.js `-r` 预加载脚本 —— 在进程中任何其他模块之前运行。
 *
 * 包装 `process.stderr.write`，静默丢弃 next-auth v5 beta + Next.js 内部
 * `Log.error` 在每次密码错误时输出的 `CredentialsSignin` 头部 + 堆栈跟踪。
 * 真实的认证错误（数据库故障、OAuth 配置错误）仍然正常冒泡。
 *
 * 通过 `playwright.config.ts` 中的
 * `NODE_OPTIONS="-r ./scripts/silence-auth-noise.cjs"` 接入
 * （生产部署环境变量中也可按需设置）。
 *
 * 实现说明 —— 噪音以两次独立的 `console.error` 调用到达（头部，然后是堆栈），
 * 每次对应一个单独的 `stderr.write` 数据块。头部携带 `CredentialsSignin` /
 * `[auth][error]` 关键词并触发抑制标志；堆栈块紧随其后，因每行都以
 * `\s+at ` 开头而被丢弃。直接 patch `console.error` 曾导致标志在翻转前
 * 就被短路 —— 这正是我们不想重现的 bug。
 */

const looksLikeAuthNoise = (msg) =>
  msg.includes('CredentialsSignin') || msg.includes('[auth][error]');

let suppressing = false;

const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function patchedWrite(chunk, ...rest) {
  const str =
    typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';

  if (str && looksLikeAuthNoise(str)) {
    suppressing = true;
    return true;
  }

  if (suppressing) {
    // 堆栈续行以空白 + `at ` 开头。末尾的空行也属于堆栈的一部分。
    // 其他内容是无关输出，关闭抑制并正常写入。
    if (/^\s+at\s/.test(str) || str === '\n' || str === '') return true;
    suppressing = false;
  }

  return origStderrWrite(chunk, ...rest);
};
