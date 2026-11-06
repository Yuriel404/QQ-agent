// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp({
  onGeneratedConsoleToken(token) {
    if (!process.stdout.isTTY) {
      throw new Error('非交互启动请设置 QQ_AGENT_CONSOLE_TOKEN 或 server.token');
    }
    // 只显示在操作者的终端，不进入应用日志、配置快照或 URL。
    process.stdout.write(`Web 控制台用户名 admin，本次启动密码 ${token}\n`);
  }
});
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
