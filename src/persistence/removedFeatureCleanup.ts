// Data left behind by features that no longer exist.
//
// Removing a module removes its code. It does not remove what that code
// wrote into the browser store on the machines that already ran it, and
// that data then sits there for the life of the install, belonging to
// nothing.
//
// For the remote segmentation runner this is worth a few lines rather
// than a shrug. It kept two keys: its configuration — the user's server,
// account and the command it ran there — and a rolling capture of the
// stdout and stderr of every ssh and scp it drove, which is whatever
// that server chose to print: paths, hostnames, job ids, error text. It
// was written to survive a reload while a run was in progress. There is
// no run to return to now, so keeping it is retention without a purpose.

/** Keys whose owning feature is gone. Append, never repurpose — a key
 *  listed here is deleted on every start, so reusing one of these names
 *  for something new would make that new thing vanish at each launch. */
const ORPHANED_KEYS = [
  // The remote SegmentAnyTree runner (removed): ssh target, port, extra
  // options, remote directories and the command run on the server.
  'pointcloudlabeler.segany.config',
  // …and its captured ssh/scp output.
  'pointcloudlabeler-segany-log',
] as const;

/** Delete them. Returns how many were actually there, which is what the
 *  test asserts on — a cleanup that silently matched nothing would look
 *  exactly like one that worked. */
export function clearRemovedFeatureData(): number {
  let removed = 0;
  for (const key of ORPHANED_KEYS) {
    try {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        removed++;
      }
    } catch {
      // A browser with site data blocked throws on access rather than
      // returning null. Nothing to clean there, and nothing worth
      // failing a launch over.
    }
  }
  return removed;
}

export const REMOVED_FEATURE_KEYS: readonly string[] = ORPHANED_KEYS;
