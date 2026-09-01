/**
 * Stroke icons matching the tab bar's style (currentColor, viewBox 24, stroke 2).
 * All directional icons are drawn LTR-physical; RTL mirroring stays in CSS —
 * `[dir="rtl"] .twisty` and `[dir="rtl"] .flow-arrow` flip the parent element.
 */

type IconProps = { size?: number };

const ATTRS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** Month navigators: previous. Points left as drawn. */
export function ChevronBack({ size = 18 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** Month navigators: next. */
export function ChevronForward({ size = 18 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/** Expanded tree caret. Flips harmlessly under the RTL rule. */
export function CaretDown({ size = 16 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** The journal's from > to flow. */
export function ArrowForward({ size = 14 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** Selected mark in the account picker. */
export function Check({ size = 16 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/** Remove a split line. */
export function XMark({ size = 16 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Collapsed tree caret: ChevronForward at the tree call sites' 16px, so they
    stop remembering the number. */
export function CaretRight() {
  return <ChevronForward size={16} />;
}

/** Header settings gear (Dashboard). */
export function Gear({ size = 22 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** Tab bar: dashboard. */
export function TabHome({ size = 22 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** Tab bar: accounts. */
export function TabAccounts({ size = 22 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 10h20" />
    </svg>
  );
}

/** Tab bar: journal. */
export function TabJournal({ size = 22 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

/** Tab bar: new entry. */
export function TabNew({ size = 22 }: IconProps) {
  return (
    <svg {...ATTRS} width={size} height={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}
