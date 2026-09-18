// Structured error payload returned by Rust commands. See
// `src-tauri/src/error.rs` for the Rust side. The renderer should branch on
// `code` (and `retryable` for offering a Retry button), and fall back to
// `message` for display.

export type AppErrorCode =
  | 'Io'
  | 'Sql'
  | 'Json'
  | 'Tauri'
  | 'NotFound'
  | 'InvalidArgument'
  | 'InvalidState'
  | 'Conflict'
  | 'Other';

export type AppErrorObject = {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  context?: string;
  entity?: string;
  id?: string;
  field?: string;
  reason?: string;
};

export function isAppError(e: unknown): e is AppErrorObject {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.message === 'string';
}

export function errMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

export function errCode(e: unknown): AppErrorCode | null {
  return isAppError(e) ? e.code : null;
}

export function isRetryable(e: unknown): boolean {
  return isAppError(e) ? e.retryable : false;
}
