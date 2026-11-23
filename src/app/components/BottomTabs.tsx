import { NavLink, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TabAccounts, TabHome, TabJournal, TabNew } from "./icons";
import { newEntryLinkState } from "../new-entry-return";

export function BottomTabs() {
  const { t } = useTranslation();
  const location = useLocation();
  const { pathname } = location;
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
      {/* Re-tapping the tab on the journal replaces rather than pushes: the bare /journal
          it navigates to is rewritten to the same remembered view, so a push would leave
          a duplicate entry that Back steps onto without moving. */}
      <NavLink to="/journal" replace={pathname === "/journal"} className={cls}>
        <TabJournal />
        {t("nav.journal")}
      </NavLink>
      {/* From the journal list, a new entry returns to that exact view once saved. */}
      <NavLink to="/new" state={newEntryLinkState(location)} className={cls}>
        <TabNew />
        {t("nav.new")}
      </NavLink>
    </nav>
  );
}
