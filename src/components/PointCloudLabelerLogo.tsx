// PointCloudLabeler brand mark + wordmark. The icon (a conifer silhouette
// dissolving into a point cloud below) is the single source of
// truth for every in-app appearance; build/icon.svg holds the same
// design at 512×512 for the OS app icon.
//
// Use:
//   <PointCloudLabelerLogo size={42} />              icon-only mark
//   <PointCloudLabelerLogo size={32} showWordmark /> mark + 'PointCloudLabeler' wordmark

interface Props {
  /** Icon side length in pixels (default 32). */
  size?: number;
  /** Render the 'PointCloudLabeler' wordmark to the right of the icon. */
  showWordmark?: boolean;
  /** Optional override for the accent green; defaults to the in-app
   *  --accent variable so the logo always matches the running theme. */
  color?: string;
  /** Adjust wordmark size — defaults to 0.62 × icon size. */
  wordmarkScale?: number;
  className?: string;
}

export function PointCloudLabelerLogoMark({ size = 32, color }: Pick<Props, 'size' | 'color'>) {
  const c = color ?? 'var(--accent)';
  // 64×64 viewBox kept compact for crisp rendering at favicon scale.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-label="PointCloudLabeler"
      role="img"
      style={{ flexShrink: 0 }}
    >
      {/* Soft sweep behind the silhouette — hints at the LiDAR origin
          of the data without dominating the mark. */}
      <ellipse cx="32" cy="52" rx="22" ry="6" fill={c} opacity="0.10"/>
      <ellipse cx="32" cy="52" rx="14" ry="3.8" fill="none" stroke={c} opacity="0.18" strokeWidth="0.6"/>

      {/* Solid conifer silhouette — 3 stacked tiers, the recognised tree. */}
      <g fill={c}>
        <path d="M32 6 L26 18 L38 18 Z" opacity="0.95"/>
        <path d="M32 14 L23 28 L41 28 Z" opacity="0.95"/>
        <path d="M32 23 L19 39 L45 39 Z" opacity="0.92"/>
      </g>

      {/* Dissolve zone — the silhouette breaks into discrete returns. */}
      <g fill={c}>
        <circle cx="25" cy="42" r="0.95"/>
        <circle cx="29" cy="44" r="1.1"/>
        <circle cx="33" cy="42.5" r="1.05"/>
        <circle cx="37" cy="44" r="1.0"/>
        <circle cx="21" cy="44" r="0.8" opacity="0.78"/>
        <circle cx="42" cy="44" r="0.8" opacity="0.78"/>
        <circle cx="17.5" cy="46" r="0.7" opacity="0.6"/>
        <circle cx="45.5" cy="46" r="0.7" opacity="0.6"/>

        {/* Trunk band. */}
        <rect x="30.4" y="44" width="3.2" height="7" rx="0.5" opacity="0.78"/>

        {/* Ground returns — sparse, asymmetric. */}
        <circle cx="14" cy="51" r="0.55" opacity="0.45"/>
        <circle cx="20" cy="52.5" r="0.5" opacity="0.50"/>
        <circle cx="26" cy="53" r="0.5" opacity="0.55"/>
        <circle cx="38" cy="53" r="0.5" opacity="0.55"/>
        <circle cx="44" cy="52.5" r="0.5" opacity="0.50"/>
        <circle cx="50" cy="51" r="0.55" opacity="0.45"/>
      </g>
    </svg>
  );
}

/** The product name, once, for the code that has to SPELL it rather
 *  than mention it in prose.
 *
 *  This exists because the wordmark below used to be written as
 *  `<span>T</span>RACE` — the name split across two JSX elements to
 *  colour the first letter. Neither half was the word, so the string
 *  "TRACE" did not appear in the file at all, and it survived two whole
 *  product renames: the rename script found nothing, grep found
 *  nothing, and the application went on introducing itself by a name
 *  nothing else in the repository used. It was reported by the author
 *  opening the built application and reading the screen.
 *
 *  A test holds this to tauri.conf.json's productName. */
export const PRODUCT_NAME = 'PointCloudLabeler';

/** Split the wordmark into the highlighted first letter and the rest.
 *
 *  Pure and exported so the split is a value a test can check, rather
 *  than markup nothing can read. This is the whole fix: the letters
 *  come from the name, so they cannot disagree with it. */
export function wordmarkParts(name: string = PRODUCT_NAME): [string, string] {
  return [name.slice(0, 1), name.slice(1)];
}

/** Tracking that suits the name's length.
 *
 *  0.18em was chosen for a five-letter name, and `0.9 / 5` reproduces
 *  it exactly; seventeen letters at that spacing is far wider than the
 *  tab bar the wordmark sits in. Derived rather than re-tuned, so the
 *  next name is legible without anybody noticing it needs to be. */
export function wordmarkTracking(name: string = PRODUCT_NAME): string {
  return `${Math.max(0.02, 0.9 / Math.max(name.length, 1)).toFixed(3)}em`;
}

/** The compact monogram for the activity rail, where a full wordmark
 *  does not fit.
 *
 *  The same defect as the wordmark, hidden the same way: this was the
 *  literal `T·R`, a monogram of a name that is nowhere in the string.
 *  Derived now, from the capitals if the name has a useful number of
 *  them and from the opening letters otherwise — so `PointCloudLabeler`
 *  gives `P·C·L` and an all-capitals name like `TRACE` gives `T·R`,
 *  which is what was there. */
export function brandMonogram(name: string = PRODUCT_NAME): string {
  const capitals = name.match(/[A-Z]/g) ?? [];
  const letters =
    capitals.length >= 2 && capitals.length <= 4
      ? capitals
      : [...name.slice(0, 2).toUpperCase()];
  return letters.join('·');
}

/** Wordmark — the product name set in a mono / display weight, with the
 *  first letter highlighted to echo the brand mark next to it. */
export function PointCloudLabelerWordmark({ size = 18, color }: { size?: number; color?: string }) {
  const baseColor = color ?? 'var(--text)';
  const accent = 'var(--accent)';
  const [head, tail] = wordmarkParts();
  return (
    <span
      className="mono"
      style={{
        fontSize: size,
        letterSpacing: wordmarkTracking(),
        fontWeight: 600,
        color: baseColor,
        lineHeight: 1,
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: accent }}>{head}</span>{tail}
    </span>
  );
}

export default function PointCloudLabelerLogo({
  size = 32,
  showWordmark = false,
  color,
  wordmarkScale = 0.62,
  className,
}: Props) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: Math.round(size * 0.32) }}
    >
      <PointCloudLabelerLogoMark size={size} color={color} />
      {showWordmark && <PointCloudLabelerWordmark size={Math.round(size * wordmarkScale)} color={color} />}
    </span>
  );
}
