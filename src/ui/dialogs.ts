// The confirm and alert boxes, awaited, through this application's own
// commands.
//
// WHY NOT window.confirm
// ----------------------
// Under Tauri the dialog plugin replaces `window.confirm` with an
// asynchronous stand-in that returns a Promise of the answer. Every call
// site here was written the browser way — `if (!window.confirm(msg))
// return;` — and a Promise is truthy, so that test never returned: the
// box opened, and the action had already run, whatever was then
// clicked. Worse, the stand-in in the plugin version shipped here
// invokes `plugin:dialog|confirm`, a command the plugin no longer
// registers, so it could not have asked anything anyway; with the
// plugin's permissions left out of the capability it rejected, and the
// crash log recorded the rejection (that is how this was found).
//
// So the question goes to a Rust command (src-tauri/src/commands/file.rs,
// beside the file dialogs, for the same reason they live there), and
// every call site awaits the answer. In the browser preview there is no
// bridge; the native synchronous `confirm` is used, and awaiting a
// boolean is the boolean.

interface DesktopDialogs {
  confirmDialog?: (message: string, title?: string) => Promise<boolean>;
  messageDialog?: (message: string, title?: string) => Promise<void>;
}

/** What this module reads from the global scope, named so tests can
 *  set it without a DOM. */
interface DialogHost {
  desktop?: DesktopDialogs;
  confirm?: (message: string) => boolean | Promise<boolean>;
  alert?: (message: string) => void | Promise<void>;
}

function host(): DialogHost {
  return globalThis as unknown as DialogHost;
}

/** Ask a yes/no question. Resolves false when no box can be shown at
 *  all: the answer that does nothing. */
export async function confirmDialog(message: string): Promise<boolean> {
  const h = host();
  try {
    if (h.desktop?.confirmDialog) return (await h.desktop.confirmDialog(message)) === true;
    if (typeof h.confirm === 'function') return (await h.confirm(message)) === true;
  } catch {
    // A box that could not be shown is a question not answered.
  }
  return false;
}

/** Tell the user something. Resolves once the box has been dismissed,
 *  or at once when none can be shown. */
export async function alertDialog(message: string): Promise<void> {
  const h = host();
  try {
    if (h.desktop?.messageDialog) { await h.desktop.messageDialog(message); return; }
    if (typeof h.alert === 'function') await h.alert(message);
  } catch {
    // Informational; nothing to do.
  }
}
