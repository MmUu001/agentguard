/**
 * JSON-RPC 错误码与错误响应构造。
 *
 * 自定义码落在 -32000 ~ -32099（JSON-RPC 2.0 留给实现自定义的区间）：
 *   -32001 POLICY_DENIED       策略拒绝（含 ask 因无审批通道而按拒绝处理）
 *   -32002 POLICY_UNAVAILABLE  策略不可用 / 判定过程本身失败 → fail-closed
 *   -32003 UPSTREAM_EXITED     upstream 已退出，未完成的请求不能让它一直等
 *   -32004 RATE_LIMITED        触发限流
 *
 * -32603（内部错误）是协议标准码，upstream 意外崩溃时用它回给 client。
 */

export const ErrorCode = {
  POLICY_DENIED: -32001,
  POLICY_UNAVAILABLE: -32002,
  UPSTREAM_EXITED: -32003,
  RATE_LIMITED: -32004,
  INTERNAL_ERROR: -32603,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface RpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type RequestId = string | number | null;

/**
 * 构造一行错误响应（已带换行符）。
 *
 * id 必须原样回显：client 靠 id 匹配它发出去的那次调用。
 * 通知（id === undefined）不构造响应 —— 通知没有 id，回 error 反而违反协议。
 */
export function buildErrorLine(
  id: RequestId,
  code: number,
  message: string,
  data?: unknown,
): Buffer {
  const error: RpcErrorPayload =
    data === undefined ? { code, message } : { code, message, data };

  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n', 'utf8');
}
