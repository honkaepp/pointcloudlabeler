// App-level error boundary. Without one, any uncaught render exception
// in a module unmounts the whole React tree → a blank white window with
// no way back. This catches the error, shows it with a stack + a
// reload button, and logs it to the crash log so a bad plugin run or a
// render edge case is recoverable + diagnosable instead of fatal.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Short label for which surface this boundary wraps (e.g. 'Editor'),
   *  shown in the fallback so the user knows what crashed. */
  label?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    // Best-effort persist to the desktop crash log; ignore if the bridge
    // isn't present (browser preview).
    try {
      const api = (window as unknown as { desktop?: { logCrash?: (msg: string) => void } }).desktop;
      api?.logCrash?.(`[render] ${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`);
    } catch { /* ignore */ }

    console.error('PointCloudLabeler render error:', error, info);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="absolute inset-0 z-[100] flex items-center justify-center p-6"
        style={{ background: 'rgba(6,11,8,0.96)' }}>
        <div className="panel rounded-md p-6 overflow-auto scroll-thin" style={{ maxWidth: 720, maxHeight: '86vh' }}>
          <div className="flex items-center gap-2 mb-3">
            <span style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--danger)', display: 'inline-block' }} />
            <div className="text-[15px]" style={{ color: 'var(--text)' }}>
              {this.props.label ? `${this.props.label} crashed` : 'Something crashed'}
            </div>
          </div>
          <div className="mono text-[12px] mb-3" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error.message}
          </div>
          {(error.stack || info?.componentStack) && (
            <pre className="mono text-[10.5px] rounded-sm p-2 mb-4 overflow-auto scroll-thin"
              style={{ color: 'var(--text-dim)', background: 'rgba(0,0,0,0.35)', maxHeight: 280 }}>
              {error.stack ?? ''}{info?.componentStack ?? ''}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary"
              onClick={() => this.setState({ error: null, info: null })}
            >
              Try to recover
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload PointCloudLabeler
            </button>
          </div>
          <div className="mono text-[10.5px] mt-3" style={{ color: 'var(--text-mute)' }}>
            "Try to recover" re-renders without reloading — your loaded cloud + edits stay
            in memory. If the same crash repeats, Reload starts fresh (unsaved edits are lost).
          </div>
        </div>
      </div>
    );
  }
}
