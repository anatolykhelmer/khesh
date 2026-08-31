import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

const ICON = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  "aria-hidden": true,
} as const;

export function BottomTabs() {
  const { t } = useTranslation();
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "tab active" : "tab");
  return (
    <nav className="bottom-tabs" aria-label={t("nav.ariaLabel")}>
      <NavLink to="/dashboard" className={cls}>
        <svg {...ICON}>
          <path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        {t("nav.dashboard")}
      </NavLink>
      <NavLink to="/accounts" className={cls}>
        <svg {...ICON}>
          <rect x="2" y="6" width="20" height="13" rx="2" />
          <path d="M2 10h20" />
        </svg>
        {t("nav.accounts")}
      </NavLink>
      <NavLink to="/journal" className={cls}>
        <svg {...ICON}>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        {t("nav.journal")}
      </NavLink>
      <NavLink to="/new" className={cls}>
        <svg {...ICON}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
        {t("nav.new")}
      </NavLink>
    </nav>
  );
}
