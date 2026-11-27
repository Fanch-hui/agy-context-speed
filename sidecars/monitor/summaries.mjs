/** 只读读取宿主的会话摘要库，补全会话标题、工作区与父子关系。不写入、不联网。 */
import { join } from 'node:path';
import { queryCached } from './sqlite.mjs';

const QUERY = `SELECT conversation_id AS id, title, preview, workspace_uris AS workspaces,
  parent_conversation_id AS parent FROM conversation_summaries`;
const NONE = new Map();

function uriBasename(raw) {
  const input = raw.trim();
  if (!input) return '';
  let pathStr = input;
  if (/^file:/i.test(input) || /^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try { pathStr = decodeURIComponent(new URL(input).pathname); } catch { return ''; }
  } else if (!/[\\/]/.test(input)) {
    return '';
  }
  const parts = pathStr.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 工作区显示名：首个目录名，多目录时附加数量。 */
export function workspaceName(urisJson) {
  let uris;
  try { uris = JSON.parse(urisJson || '[]'); } catch { return ''; }
  if (!Array.isArray(uris) || typeof uris[0] !== 'string') return '';
  const name = uriBasename(uris[0]);
  if (!name) return '';
  return uris.length > 1 ? `${name} +${uris.length - 1}` : name;
}

function toSummary(row) {
  const preview = String(row.preview || '').split('\n', 1)[0];
  return {
    title: (row.title || preview).slice(0, 72).trim(),
    workspace: workspaceName(row.workspaces),
    parent: row.parent || '',
  };
}

/** 返回 Map<会话 UUID, { title, workspace, parent }>；摘要库不可用时返回空 Map。 */
export function readSummaries(rootDir) {
  const file = join(rootDir, 'conversation_summaries.db');
  return queryCached(file, QUERY, rows => new Map(rows.map(row => [row.id, toSummary(row)]))) ?? NONE;
}
