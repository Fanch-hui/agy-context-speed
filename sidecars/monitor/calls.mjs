/**
 * 读取宿主为每个会话保存的模型调用元数据（<数据目录>/conversations/<uuid>.db 的 gen_metadata 表）。
 * 会话日志里没有的首字延迟、流式耗时和真实上下文上限都在这里。
 *
 * 每行是一条未公开的 protobuf 消息，下面的字段编号取自宿主 language_server 内嵌的定义，
 * 并用本机真实数据核对过。宿主升级改动格式时这里会读不到数据，调用方退回日志估算。
 */
import { join } from 'node:path';
import { queryCached } from './sqlite.mjs';

const MAX_CALLS = 5000;
const QUERY = `SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT ${MAX_CALLS}`;

const GEN = { chatModel: 1 };
const CHAT_MODEL = {
  model: 3, usage: 4, chatStartMetadata: 9, timeToFirstToken: 11, streamingDuration: 12,
  responseModel: 19, modelDisplayName: 21, responseModelFull: 22,
};
const USAGE = { model: 1, inputTokens: 2, outputTokens: 3, cacheWriteTokens: 4, cacheReadTokens: 5 };
const CHAT_START = { contextWindowMetadata: 10 };
const CONTEXT_WINDOW = { maxContextTokens: 4 };
const DURATION = { seconds: 1, nanos: 2 };

const WIRE_VARINT = 0, WIRE_FIXED64 = 1, WIRE_BYTES = 2, WIRE_FIXED32 = 5;

function readVarint(buf, pos) {
  let value = 0, scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('varint 越界');
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return [value, pos];
    scale *= 128;
  }
}

/** 解出一层消息：字段编号 → 首次出现的值（varint 为数字，嵌套消息/字符串为 Uint8Array）。 */
export function readFields(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag, value;
    [tag, pos] = readVarint(buf, pos);
    const wire = tag & 7;
    if (wire === WIRE_VARINT) [value, pos] = readVarint(buf, pos);
    else if (wire === WIRE_FIXED64) { value = null; pos += 8; }
    else if (wire === WIRE_FIXED32) { value = null; pos += 4; }
    else if (wire === WIRE_BYTES) {
      let size;
      [size, pos] = readVarint(buf, pos);
      if (pos + size > buf.length) throw new RangeError('字段越界');
      value = buf.subarray(pos, pos + size);
      pos += size;
    } else throw new RangeError(`不支持的 wire type ${wire}`);
    fields[tag >>> 3] ??= value;
  }
  return fields;
}

const message = (value) => value instanceof Uint8Array ? readFields(value) : {};
const count = (value) => typeof value === 'number' ? value : null;
const text = (value) => value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : '';

function seconds(value) {
  if (!(value instanceof Uint8Array)) return null;
  const d = readFields(value);
  return (d[DURATION.seconds] || 0) + (d[DURATION.nanos] || 0) / 1e9;
}

/** 一条 gen_metadata → 一次模型调用。 */
export function decodeCall(data) {
  const chatModel = message(readFields(data)[GEN.chatModel]);
  const usage = message(chatModel[CHAT_MODEL.usage]);
  const contextWindow = message(message(chatModel[CHAT_MODEL.chatStartMetadata])[CHAT_START.contextWindowMetadata]);
  return {
    input: count(usage[USAGE.inputTokens]),
    cached: count(usage[USAGE.cacheReadTokens]),
    cacheWrite: count(usage[USAGE.cacheWriteTokens]),
    output: count(usage[USAGE.outputTokens]),
    ttft: seconds(chatModel[CHAT_MODEL.timeToFirstToken]),
    stream: seconds(chatModel[CHAT_MODEL.streamingDuration]),
    maxContextTokens: count(contextWindow[CONTEXT_WINDOW.maxContextTokens]),
    model: count(chatModel[CHAT_MODEL.model]) ?? count(usage[USAGE.model]),
    responseModel: text(chatModel[CHAT_MODEL.responseModel]),
    responseModelFull: text(chatModel[CHAT_MODEL.responseModelFull]),
    modelDisplayName: text(chatModel[CHAT_MODEL.modelDisplayName]),
  };
}

/** 该会话最近的模型调用，按时间先后排列；读不到时返回空数组。 */
export function readRecentCalls(rootDir, uuid) {
  const file = join(rootDir, 'conversations', `${uuid}.db`);
  return queryCached(file, QUERY, rows => rows.map(row => decodeCall(row.data)).reverse()) ?? [];
}
