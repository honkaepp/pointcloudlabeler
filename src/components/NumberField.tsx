// A numeric input that keeps TEXT in state, not a number.
//
// The obvious version — `value={String(n)}` with `parseFloat` on every
// keystroke — cannot be typed into. Clearing the field to type a new
// value gives `parseFloat('')` = NaN, so it snaps back to the old
// number; a minus sign alone is NaN, so a negative default like the
// reflectance band's −20 dB can never be edited to −15; and "0." is
// NaN too, so no decimal can be entered from the left. The field looks
// editable and is not, which is worse than being disabled.
//
// So the text is the state, the caller parses once when it builds the
// payload (`parseNum`), and an unparseable field falls back to its
// default there — visibly, at submit, rather than silently on every
// keypress.

/// `Number`, not `parseFloat`: parseFloat accepts a valid PREFIX, so
/// "1e" reads as 1 and "0.5 m" as 0.5. For a parameter field that is
/// too loose — a half-typed exponent would submit as a number three
/// orders of magnitude off, with the field showing "1e" and no
/// complaint. `Number` rejects the whole string or takes it, and the
/// empty case is guarded because `Number('')` is 0.
export function parseNum(text: string, fallback: number): number {
  const t = text.trim();
  if (t === '') return fallback;
  const v = Number(t);
  return Number.isFinite(v) ? v : fallback;
}

/** Same, for a count: rounded, and never below `min` (default 1). */
export function parseCount(text: string, fallback: number, min = 1): number {
  const t = text.trim();
  if (t === '') return fallback;
  const v = Number(t);
  return Number.isFinite(v) ? Math.max(min, Math.round(v)) : fallback;
}

interface Props {
  label: string;
  value: string;
  onChange: (text: string) => void;
  /** Shown on hover — what the number means, and where it came from. */
  title?: string;
  /** Fixed width in px; omit to fill the row. */
  width?: number;
  placeholder?: string;
}

export default function NumberField({ label, value, onChange, title, width, placeholder }: Props) {
  return (
    <label
      className={`flex flex-col gap-0.5 ${width ? '' : 'flex-1 min-w-0'}`}
      title={title}
      style={width ? { width } : undefined}
    >
      <span className="mono" style={{ fontSize: 9, color: 'var(--text-mute)' }}>{label}</span>
      <input
        className="mono text-[11px] py-1 px-1.5 rounded-md outline-none w-full"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        inputMode="decimal"
      />
    </label>
  );
}
