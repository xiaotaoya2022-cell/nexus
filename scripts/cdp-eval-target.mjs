// CDP helper：对指定标题的 page target 执行 JS（默认找非 Nexus 的第一个 page）
const list = await fetch('http://127.0.0.1:9333/json').then(r => r.json());
const needle = process.argv[3] ?? 'DeepSeek';
const page = list.find(t => t.type === 'page' && t.title.includes(needle) && !/index\.html/.test(t.url));
if (!page) { console.error('target not found'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const res = await send('Runtime.evaluate', { expression: process.argv[2], returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result?.value ?? res, null, 1));
ws.close();
