import { readFileSync } from 'node:fs';
import { SidecarApp, Response } from 'sidecar_sdk';
import { getSnapshot } from './metrics.mjs';
import { summarizeAllWindows } from './aggregate.mjs';
import { contextLimit, cycleContextLimit, updateWindowSettings, windowSettings } from './settings.mjs';

const app = new SidecarApp();
const html = () => readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const js = () => readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const winJs = () => readFileSync(new URL('./windows-ui.js', import.meta.url), 'utf8');
const css = () => readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

app.page('/', html);
app.page('/app.js', () => new Response(js(), { contentType: 'text/javascript; charset=utf-8' }));
app.page('/windows-ui.js', () => new Response(winJs(), { contentType: 'text/javascript; charset=utf-8' }));
app.page('/styles.css', () => new Response(css(), { contentType: 'text/css; charset=utf-8' }));
app.api('/api/telemetry', (data) => {
  const result = getSnapshot({
    id: typeof data?.sessionId === 'string' ? data.sessionId.slice(0, 140) : '',
    conversationId: typeof data?.conversationId === 'string' ? data.conversationId.slice(0, 100) : '',
    defaultContextLimit: contextLimit(),
  });
  return { ...result, windows: summarizeAllWindows({ windows: windowSettings() }) };
}, 'POST');
app.api('/api/context-limit/next', cycleContextLimit, 'POST');
app.api('/api/settings/windows', (data) => updateWindowSettings(data), 'POST');
app.run();
