// 共享的 ui/app 拆分加载器（M9，2026-09-19）。
//
// ui/app.js 拆分为 1 个 ESM 桥和若干普通脚本段：
//   ui/app.js          ES module：import /vendor/*.js 并挂到 window
//   ui/app/*.js        普通脚本：按 index.html 的 defer 顺序执行，共享全局词法绑定
//
// 测试侧（render / scroll / skill-modal-ui / coverage-wiring）沿用原来的
// vm / window.eval 方案跑这段代码。
// 各测试的共同诉求：
//   1. 按依赖顺序拿到**拼接后的完整代码**（顺序 = index.html 的 defer 顺序）；
//   2. 桥文件不做 vm 执行 —— 它只有 import + window 赋值，测试改为直接把
//      vendor 导出注入 sandbox（和以前剥离 import 后注入同名绑定是同一件事）；
//   3. 普通脚本段的 'use strict' 头与注释行原样保留即可（vm.Script 全兼容）。
//
// 用法：
//   const { code, files } = loadUiAppCode();
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ui/app/ 段文件名（= 加载顺序 = index.html 的 defer 顺序）。 */
export const APP_PARTS = [
  '00-core.js', '01-boot.js', '02-sse-sessions.js', '03-snowluma.js',
  '04-archive-usage.js', '05-memory-settings.js', '06-settings-render.js',
  '07-settings-events.js', '08-modals.js', '09-active-settings.js',
  '10-console-actions.js', '12-concept2-ui.js', '13-search-pool.js', '11-init.js'
];

/** 读单段。 */
export function readAppPart(name) {
  return fs.readFileSync(path.join(ROOT, 'ui', 'app', name), 'utf8');
}

/**
 * 按序拼接成一份完整代码（段与段之间空行分隔）。
 * 返回 { code, files }：files 供诊断输出"实际加载了哪些段"。
 */
export function loadUiAppCode() {
  const files = [];
  const chunks = [];
  for (const name of APP_PARTS) {
    files.push(name);
    chunks.push(readAppPart(name));
  }
  return { code: chunks.join('\n\n'), files };
}
