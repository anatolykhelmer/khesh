import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function BottomTabs() {
  const { t } = useTranslation();
  return (
    <nav className="bottom-tabs" aria-label={t("nav.ariaLabel")}>
      <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "tab active" : "tab")}>
        {t("nav.dashboard")}
      </NavLink>
      <NavLink to="/accounts" className={({ isActive }) => (isActive ? "tab active" : "tab")}>
        {t("nav.accounts")}
      </NavLink>
      <NavLink to="/journal" className={({ isActive }) => (isActive ? "tab active" : "tab")}>
        {t("nav.journal")}
      </NavLink>
      <NavLink to="/new" className={({ isActive }) => (isActive ? "tab active" : "tab")}>
        {t("nav.new")}
      </NavLink>
    </nav>
  );
}
