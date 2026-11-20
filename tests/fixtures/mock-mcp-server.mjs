/**
 * 测试用假 MCP server —— 只实现 W1 验收需要的行为。
 *
 * 刻意覆盖的边界：
 *   - sampling/createMessage 反向请求（server → client，第 4 个方向）
 *   - 超长行（2 MiB）
 *   - 一行被拆成 3 次 write（验证代理的分割器不依赖单次 chunk 完整）
 *   - 非 ASCII / 大整数 / 浮点误差值（验证代理没有 JSON 往返重排）
 *   - 非零退出码传递
 */

import { Buffer } from 'node:buffer';

const LF = 0x0a;

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let rest = Buffer.alloc(0);
let pendingSampling = null;
let samplingSeq = 0;

process.stdin.on('data', (chunk) => {
  rest = rest.length === 0 ? chunk : Buffer.concat([rest, chunk]);
  for (;;) {
    const nl = rest.indexOf(LF);
    if (nl === -1) break;
    const line = rest.subarray(0, nl).toString('utf8');
    rest = rest.subarray(nl + 1);
    if (line.trim() !== '') handle(line);
  }
});

process.stdin.on('end', () => process.exit(0));

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }

  if (msg.method === undefined) {
    if (pendingSampling !== null && msg.id === pendingSampling.id) {
      const { replyTo, callId } = pendingSampling;
      pendingSampling = null;
      replyTo(callId, {
        content: [{ type: 'text', text: 'sampling-ok:' + JSON.stringify(msg.result ?? null) }],
      });
    }
    return;
  }

  if (msg.id === undefined) return; // 通知，不需要回

  const { id, method, params = {} } = msg;

  switch (method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: { listChanged: false }, sampling: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.1' },
        },
      });
      return;

    case 'tools/list':
      write({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            { name: 'echo', description: 'echo arguments back', inputSchema: { type: 'object' } },
            { name: 'big', description: 'measure text length', inputSchema: { type: 'object' } },
            { name: 'sample', description: 'request sampling', inputSchema: { type: 'object' } },
            { name: 'split', description: 'write response in chunks', inputSchema: { type: 'object' } },
            { name: 'crash', description: 'exit non-zero', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;

    case 'tools/call':
      handleCall(id, params);
      return;

    default:
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

function handleCall(id, params) {
  const name = params.name;
  const args = params.arguments ?? {};

  switch (name) {
    case 'echo':
      // JSON.stringify 在这里是「上游的真实输出」，代理不得篡改它的字节
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(args) }] } });
      return;

    case 'big': {
      const text = typeof args.text === 'string' ? args.text : '';
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text.length) }] } });
      return;
    }

    case 'sample': {
      const srvId = 'srv-' + String(++samplingSeq);
      pendingSampling = {
        id: srvId,
        replyTo: (callId, result) => write({ jsonrpc: '2.0', id: callId, result }),
        callId: id,
      };
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: srvId,
          method: 'sampling/createMessage',
          params: {
            messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
            maxTokens: 16,
          },
        }) + '\n',
      );
      return;
    }

    case 'split': {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'chunked' }] },
      });
      const third = Math.floor(payload.length / 3);
      process.stdout.write(payload.slice(0, third));
      setTimeout(() => {
        process.stdout.write(payload.slice(third, third * 2));
        setTimeout(() => process.stdout.write(payload.slice(third * 2) + '\n'), 20);
      }, 20);
      return;
    }

    case 'crash':
      setTimeout(() => process.exit(7), 10);
      return;

    case 'quit':
      // 回完响应立刻退出：验证代理不会吞掉最后一行
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'last-words' }] } });
      setTimeout(() => process.exit(0), 0);
      return;

    default:
      write({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
  }
}
