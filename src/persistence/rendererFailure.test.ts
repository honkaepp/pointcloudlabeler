import { describe, it, expect } from 'vitest';
import { describeRendererFailure, type RendererFailure } from './rendererFailure';

const at = (s: number) => `T${s}`;
const base: RendererFailure = {
  kind: 'render-process-exited', reason: 'out-of-memory', exitCode: -2147483645,
  description: '', at: 1000, reloaded: true,
};

describe('describeRendererFailure', () => {
  /** The case this exists for: the renderer killed for memory at the
   *  end of a build, the page reloaded by the Rust side. */
  it('says the interface was reloaded and why, and that the backend kept going', () => {
    const { title, detail } = describeRendererFailure(base, 'C:\\Users\\x\\crash.log', at);
    expect(title).toBe('The interface was reloaded at T1000 because its renderer process exited: it ran out of memory.');
    expect(detail).toContain('kept running');
    expect(detail).toContain('checkpoints are kept');
    expect(detail).toContain('Exit code -2147483645.');
    expect(detail).toContain('Written to C:\\Users\\x\\crash.log.');
  });

  it('does not claim a reload it did not do', () => {
    const { title } = describeRendererFailure({ ...base, reloaded: false, reason: 'crashed' }, null, at);
    expect(title).toBe("The interface's renderer process exited at T1000: it crashed.");
    expect(title).not.toContain('reloaded');
  });

  it('tells the user to restart when the browser process itself is gone', () => {
    const { title } = describeRendererFailure({ ...base, kind: 'browser-process-exited', reason: 'terminated', reloaded: false }, null, at);
    expect(title).toContain('Restart PointCloudLabeler');
    expect(title).toContain('ended from outside');
  });

  it('carries an unknown reason through rather than dropping it', () => {
    const { title } = describeRendererFailure({ ...base, reason: 'reason-42' }, null, at);
    expect(title).toContain('reason: reason-42');
  });

  it('names the process when the browser described it, and omits the log when there is none', () => {
    const { detail } = describeRendererFailure({ ...base, description: 'Renderer' }, null, at);
    expect(detail).toContain('process "Renderer"');
    expect(detail).not.toContain('Written to');
  });
});
