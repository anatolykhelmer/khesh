import type { ReactNode } from "react";

/** Keeps money amounts and rates left-to-right even inside an RTL screen. */
export function Ltr({ children }: { children: ReactNode }) {
  return <span dir="ltr">{children}</span>;
}
