// The names the widened activity bar (ActivityBar.tsx) shows
// beside its icons, from the labels the icons already carry as tooltips.

/** A tool's name: its label up to the dash that starts the description,
 *  without a closing "(…)" — "Survey — measure lines…" → "Survey",
 *  "Thinning simulator (harvennus)" → "Thinning simulator". */
export function shortName(label: string): string {
  return label.split(' — ')[0].replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
}
