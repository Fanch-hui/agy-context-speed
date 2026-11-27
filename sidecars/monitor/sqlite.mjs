/** 只读查询宿主的 SQLite 文件，结果按文件修改时间缓存。 */
import { statSync } from 'node:fs';

// node:sqlite 自 Node 22.5 起内置；更旧的运行时没有它，调用方各自退回不依赖数据库的行为。
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* 见上 */ }

const cache = new Map();
const reported = new Set();

function mtime(file) { try { return statSync(file).mtimeMs; } catch { return 0; } }

/**
 * 以只读方式执行 sql，把行交给 transform，返回其结果；文件未变化时直接返回缓存。
 * 数据库不存在或不可用时返回 null。宿主正在写库或表结构变化时沿用上次结果，同一错误只记录一次。
 */
export function queryCached(file, sql, transform) {
  const stamp = `${mtime(file)}:${mtime(`${file}-wal`)}`;
  if (!sqlite || stamp === '0:0') return null;
  const key = `${file}\n${sql}`;
  const hit = cache.get(key);
  if (hit?.stamp === stamp) return hit.result;
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const result = transform(db.prepare(sql).all());
    cache.set(key, { stamp, result });
    return result;
  } catch (err) {
    const message = `${sql.slice(0, 40)}…：${String(err?.message || err)}`;
    if (!reported.has(message)) { reported.add(message); console.error('读取宿主数据库失败：', message); }
    return hit?.result ?? null;
  } finally { db?.close(); }
}
