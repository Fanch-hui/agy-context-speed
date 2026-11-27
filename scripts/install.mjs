import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..');
const configDir = join(homedir(), '.gemini', 'config');
const pluginsDir = join(configDir, 'plugins');
const installPath = join(pluginsDir, 'agy-context-speed');
const configPath = join(configDir, 'config.json');
const displayName = 'agy-context-speed/monitor';
const marker = JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8'));
if (marker.name !== 'agy-context-speed') throw new Error('插件标识与安装器不匹配');

let cfg = {};
if (existsSync(configPath)) {
  try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw new Error(`配置文件不是有效 JSON，请检查：${configPath}`); }
}
if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('全局配置需要 JSON 对象');
if (existsSync(installPath)) {
  let old;
  try { old = JSON.parse(readFileSync(join(installPath, 'plugin.json'), 'utf8')); } catch {}
  if (old?.name !== 'agy-context-speed') throw new Error('安装目录已被其他插件占用');
}
mkdirSync(pluginsDir, { recursive: true });
const workDir = mkdtempSync(join(pluginsDir, '.agy-context-speed-'));
try {
  cpSync(join(source, 'plugin.json'), join(workDir, 'plugin.json'));
  cpSync(join(source, 'sidecars'), join(workDir, 'sidecars'), { recursive: true });
  cpSync(join(source, 'README.md'), join(workDir, 'README.md'));
  if (existsSync(installPath)) {
    const backup = join(configDir, `.agy-context-speed-backup-${Date.now()}`);
    renameSync(installPath, backup);
    console.log(`已有插件备份：${backup}`);
  }
  renameSync(workDir, installPath);
} finally { if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true }); }
if (existsSync(configPath)) {
  const backupPath = `${configPath}.bak-agy-context-speed-${Date.now()}`;
  copyFileSync(configPath, backupPath);
  console.log(`全局配置备份：${backupPath}`);
}
cfg.sidecars = cfg.sidecars && typeof cfg.sidecars === 'object' && !Array.isArray(cfg.sidecars) ? cfg.sidecars : {};
cfg.sidecars[displayName] = { ...(cfg.sidecars[displayName] || {}), enabled: true };
const tmpConfig = join(configDir, `.config-agy-context-speed-${process.pid}.tmp`);
try {
  writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmpConfig, configPath);
} finally { if (existsSync(tmpConfig)) rmSync(tmpConfig, { force: true }); }
console.log(`\n安装成功：${installPath}`);
console.log('请重新打开 Antigravity App → ⋮ → Extensions → Context & Speed。');
