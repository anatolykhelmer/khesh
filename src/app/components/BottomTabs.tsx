import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TabAccounts, TabHome, TabJournal, TabNew } from "./icons";

export function BottomTabs() {
  const { t } = useTranslation();
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? "tab active" : "tab");
  return (
    <nav className="bottom-tabs" aria-label={t("nav.ariaLabel")}>
      <NavLink to="/dashboard" className={cls}>
        <TabHome />
        {t("nav.dashboard")}
      </NavLink>
      <NavLink to="/accounts" className={cls}>
        <TabAccounts />
        {t("nav.accounts")}
      </NavLink>
      <NavLink to="/journal" className={cls}>
        <TabJournal />
        {t("nav.journal")}
      </NavLink>
      <NavLink to="/new" className={cls}>
        <TabNew />
        {t("nav.new")}
      </NavLink>
    </nav>
  );
}
