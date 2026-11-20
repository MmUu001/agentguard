/**
 * 测试用的最小 MCP 客户端：按行收发 JSON-RPC，按 id 匹配响应。
 * 同时负责两件事：
 *   - 记录所有**不是合法 JSON** 的 stdout 行（用于验证「stdout 无噪声」）
 *   - 处理 server → client 的请求（sampling / roots），验证第 4 个方向
 */

export class McpClient {
  constructor(proc, { timeoutMs = 15000, serverRequestHandler } = {}) {
    this.proc = proc;
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.invalidLines = [];
    this.serverRequests = [];
    this.stderr = '';
    this.rawLines = [];
    this.serverRequestHandler =
      serverRequestHandler ??
      ((msg, respond) => respond({ content: [{ type: 'text', text: 'default' }], model: 'm', role: 'assistant' }));

    this.exited = new Promise((res) => proc.once('close', (code) => res(code)));
    proc.stderr.on('data', (d) => {
      this.stderr += d.toString('utf8');
    });

    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        if (line.trim() !== '') this.#dispatch(line);
      }
    });

    this.exited.then(() => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('upstream exited before responding'));
      }
      this.pending.clear();
    });
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** 发一次 tools/call 并拿到 { msg, line } */
  call(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  #dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.invalidLines.push(line.slice(0, 120));
      return;
    }

    if (msg.method !== undefined) {
      if (msg.id === undefined) return;
      this.serverRequests.push(msg.method);
      const respond = (result) => this.send({ jsonrpc: '2.0', id: msg.id, result });
      this.serverRequestHandler(msg, respond);
      return;
    }

    this.rawLines.push(line);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve({ msg, line });
  }

  async close() {
    this.proc.stdin.end();
    const code = await Promise.race([
      this.exited,
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    if (code === 'timeout') this.proc.kill();
    return code;
  }

  kill() {
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill();
  }
}
