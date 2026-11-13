// What the editor of this window has open, for the parts of the
// application outside it: renaming the project (App.tsx) closes it, so it
// refuses over unsaved edits and opens the same dataset again afterwards.
// EditorModule keeps it current; nothing else writes it.

export interface EditorSession {
  /** The open dataset's directory, or null. */
  dir: string | null;
  /** The open dataset has unsaved edits. */
  dirty: boolean;
}

let session: EditorSession = { dir: null, dirty: false };

export function setEditorSession(next: EditorSession): void {
  session = next;
}

export function getEditorSession(): EditorSession {
  return session;
}
