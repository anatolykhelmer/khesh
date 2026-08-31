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

/** Month navigators: next. Also the collapsed tree caret (pass size 16). */
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
