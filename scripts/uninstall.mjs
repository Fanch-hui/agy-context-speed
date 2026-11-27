import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const configDir = join(homedir(), '.gemini', 'config');
const path = join(configDir, 'plugins', 'agy-context-speed');
const file = join(configDir, 'config.json');
if (existsSync(path)) {
  let p;
  try { p = JSON.parse(readFileSync(join(path, 'plugin.json'), 'utf8')); } catch {}
  if (p?.name !== 'agy-context-speed') throw new Error('检测到其他插件，停止卸载');
  rmSync(path, { recursive: true, force: true });
  console.log(`已移除 ${path}`);
}
if (existsSync(file)) {
  let cfg;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('全局配置无法解析，请手动关闭 sidecar 开关'); }
  if (cfg?.sidecars?.['agy-context-speed/monitor']) {
    const backup = `${file}.bak-agy-context-speed-${Date.now()}`;
    copyFileSync(file, backup);
    cfg.sidecars['agy-context-speed/monitor'].enabled = false;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
    console.log(`已禁用 Sidecar，配置备份：${backup}`);
  }
}
console.log('卸载完成。重启 Antigravity 生效。');
