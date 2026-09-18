import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** Every Tauri command the frontend bridge invokes, in source order. */
function invokedCommands(): string[] {
  const src = readFileSync('src/persistence/desktopBridge.ts', 'utf8');
  const out = new Set<string>();
  // `ctx.invoke<T>('name', …)` and `ctx.invoke('name', …)`. The generic,
  // when present, can itself contain quotes (union types like
  // `'a' | 'b'`), so match the command as the FIRST argument after the
  // opening paren rather than the first quoted run on the line.
  for (const m of src.matchAll(/\binvoke\s*(?:<[\s\S]*?>)?\s*\(\s*'([a-z0-9_]+)'/g)) {
    out.add(m[1]);
  }
  return [...out];
}

/** Every command name inside `tauri::generate_handler![…]` in lib.rs. */
function registeredCommands(): Set<string> {
  const src = readFileSync('src-tauri/src/lib.rs', 'utf8');
  const start = src.indexOf('generate_handler![');
  expect(start, 'lib.rs no longer has a generate_handler! list').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('])', start));
  const out = new Set<string>();
  // `module::command_name,` — take the last path segment. Comment lines
  // start with `//` and carry no `::`, so they fall out on their own.
  for (const line of body.split('\n')) {
    const code = line.split('//')[0];
    const m = /([a-z0-9_]+)::([a-z0-9_]+)\s*,?\s*$/.exec(code.trim());
    if (m) out.add(m[2]);
  }
  return out;
}

/** A frontend that invokes a command Rust never registered fails at
 *  runtime with "Command <name> not found" — and only for the user who
 *  reaches that panel, since nothing on the way there touches it.
 *
 *  This is not a type error in either language: the bridge names the
 *  command in a string, and `lib.rs` names it in a macro. tsc sees a
 *  string; rustc sees a function that is used. The two never meet, so
 *  adding a command and forgetting the registration compiles, builds,
 *  ships, and breaks one screen.
 *
 *  It happened: `octree_read_stems` was written, the bridge entry added,
 *  and the registration was a separate edit in a separate file. */
describe('desktop bridge ↔ Tauri handler list', () => {
  it('invokes only commands Rust has registered', () => {
    const registered = registeredCommands();
    const missing = invokedCommands().filter(c => !registered.has(c));
    expect(
      missing,
      'these are invoked by the bridge but absent from generate_handler! in lib.rs — they fail at runtime',
    ).toEqual([]);
  });

  /** Sanity on the scrapers themselves: a regex that quietly matched
   *  nothing would make the test above pass for the wrong reason. */
  it('finds both sides', () => {
    expect(invokedCommands().length).toBeGreaterThan(100);
    expect(registeredCommands().size).toBeGreaterThan(100);
    expect(invokedCommands()).toContain('octree_read_stems');
    expect(registeredCommands()).toContain('octree_read_stems');
  });
});
