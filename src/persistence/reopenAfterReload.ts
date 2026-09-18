/** The dataset a reload of the whole application should come back to.
 *
 *  The "graphics context was lost" overlay's last resort is
 *  window.location.reload(), and the application came back at the
 *  project's dataset list: the open project is restored on start, the
 *  open dataset was not, and a user whose view had just died was then
 *  left to find their cloud again. This is the crumb that reopens it.
 *
 *  sessionStorage, on purpose. It lives exactly as long as the WebView's
 *  session — through a reload, not through a restart — so a dataset is
 *  only ever reopened by the reload that asked for it, and nothing here
 *  is a setting (see settingsStore.ts for what those are). Every access
 *  is guarded: storage can be absent or throw, and a reload without the
 *  crumb is still a reload. */
const KEY = 'pointcloudlabeler-reopen-dataset';

export interface CrumbStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStore(): CrumbStore | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Remember `dir` for the reload about to happen. */
export function rememberReopen(dir: string, store: CrumbStore | null = sessionStore()): void {
  try {
    store?.setItem(KEY, dir);
  } catch {
    // Nothing to do: the reload goes ahead and lands on the list.
  }
}

/** The remembered dataset, forgotten on the way out: one reload reopens
 *  it once, and a later start of the application does not. */
export function takeReopen(store: CrumbStore | null = sessionStore()): string | null {
  try {
    const dir = store?.getItem(KEY) ?? null;
    if (dir !== null) store?.removeItem(KEY);
    return dir || null;
  } catch {
    return null;
  }
}
