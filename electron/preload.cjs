// 焦点回收通道（2026-09-26）。
//
// 背景（electron/electron#41602「Confirm/Alert popups break focus」，Windows）：
// Electron 把 alert/confirm/prompt 渲染成**系统同步对话框**，关闭后窗口不认领
// 回键盘焦点 —— 表现就是"弹过任意弹窗后所有输入框打不了字，连点输入框都
// 抢不回焦点"，必须点标题栏 / alt-tab 才恢复。这是 Chromium 侧的 bug，
// 渲染层自己 focus() 救不回来，可靠解是主进程做 BrowserWindow.focus()（OS 级激活）。
//
// 只暴露一个 refocus()：给 ui/app/00-core.js 的对话框包装层调用。
// 用 CommonJS：preload 在各 Electron 版本下都稳，不冒险用 ESM preload。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgentShell', {
  refocus: () => {
    try { ipcRenderer.send('app-refocus'); } catch { /* ignore */ }
  }
});
