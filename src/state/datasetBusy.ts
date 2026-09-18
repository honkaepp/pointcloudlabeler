/** Whether a native command is currently rewriting the active dataset
 *  on disk, and the lock that says so.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Commands like bake, ground classification, segmentation, normalise and
 *  the column add/remove passes stream the whole dataset and rewrite
 *  `octree.bin` in place — seconds to minutes on a real cloud. They then
 *  re-open the dataset so the UI picks up the schema change, and that
 *  re-open reloads `patches.bin` from disk over the in-memory edit store
 *  and clears undo.
 *
 *  The viewport stays interactive throughout. So an edit made during that
 *  window is destroyed by the reload that follows: it was never in
 *  `patches.bin`, the reload replaces the store with what is, undo is
 *  cleared, and the save indicator then reads "Saved". Silent, and
 *  unrecoverable.
 *
 *  Editing is therefore BLOCKED while the lock is held, not warned about.
 *  Warning afterwards is too late to help, and saving the in-memory store
 *  after a bake would be worse than losing it: it would re-apply records
 *  the bake had already burned into `octree.bin`.
 *
 *  WHY IT LIVES HERE AND NOT IN THE PANELS
 *  ---------------------------------------
 *  The lock is taken in `desktopBridge.ts`, around the command wrappers
 *  themselves, rather than by each panel that calls one. There are a
 *  dozen such commands reachable from six panels; asking every call site
 *  to remember is how one gets missed, and a missed one fails silently in
 *  exactly the way this whole mechanism exists to prevent. Holding it at
 *  the one place the commands are declared means a panel cannot forget,
 *  and a command added later inherits the protection by being declared
 *  next to its neighbours.
 *
 *  Deliberately a plain module rather than React state: `desktopBridge`
 *  is not a component and has no context to read.
 */

/** Depth, not a boolean. Two dataset-mutating commands can be started
 *  from two open floating panels; with a boolean, whichever finished
 *  first would release the other's hold and re-open editing while a
 *  rewrite was still in flight. */
let depth = 0;

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function isDatasetBusy(): boolean {
  return depth > 0;
}

/** Subscribe to changes. Returns an unsubscribe function — the shape
 *  `useSyncExternalStore` wants. */
export function subscribeDatasetBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Run `fn` holding the lock.
 *
 *  Releases in `finally`, always: a hold that leaked on an error path
 *  would lock editing for the rest of the session, which is its own bug
 *  and a more visible one than the problem being solved. */
export async function withDatasetBusy<T>(fn: () => Promise<T>): Promise<T> {
  depth += 1;
  notify();
  try {
    return await fn();
  } finally {
    depth = Math.max(0, depth - 1);
    notify();
  }
}
