import { Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Banner } from "./components/Banner";
import { BottomTabs } from "./components/BottomTabs";
import { useLedger } from "./ledger-context";
import { AccountDetailScreen } from "./screens/AccountDetailScreen";
import { AccountFormScreen } from "./screens/AccountFormScreen";
import { AccountsScreen } from "./screens/AccountsScreen";
import { BudgetEditScreen } from "./screens/BudgetEditScreen";
import { BudgetFormScreen } from "./screens/BudgetFormScreen";
import { BudgetScreen } from "./screens/BudgetScreen";
import { DashboardScreen } from "./screens/DashboardScreen";
import { EntryDetailScreen } from "./screens/EntryDetailScreen";
import { JournalScreen } from "./screens/JournalScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { StatsScreen } from "./screens/StatsScreen";
import { TransferFormScreen } from "./screens/TransferFormScreen";
import { useAppUpdate } from "./use-app-update";

function Shell() {
  return (
    <div className="app-shell">
      <div className="app-content">
        <Routes>
          <Route path="/dashboard" element={<DashboardScreen />} />
          <Route path="/stats" element={<StatsScreen />} />
          <Route path="/budget" element={<BudgetScreen />} />
          <Route path="/budget/new" element={<BudgetFormScreen />} />
          <Route path="/budget/edit" element={<BudgetEditScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/accounts" element={<AccountsScreen />} />
          <Route path="/accounts/new" element={<AccountFormScreen />} />
          <Route path="/accounts/:accountId" element={<AccountDetailScreen />} />
          <Route path="/journal" element={<JournalScreen />} />
          <Route path="/new" element={<TransferFormScreen key="new" />} />
          <Route path="/journal/:entryId" element={<EntryDetailScreen />} />
          <Route path="/journal/:entryId/edit" element={<TransferFormScreen key="edit" />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
      <BottomTabs />
    </div>
  );
}

export function App() {
  const { t } = useTranslation();
  const { book, loading, error, clearError } = useLedger();
  const { needRefresh, reload, dismiss } = useAppUpdate();

  if (loading) {
    return (
      <main className="screen">
        <p>{t("app.loading")}</p>
      </main>
    );
  }

  return (
    <>
      {error ? <Banner message={error} onDismiss={clearError} /> : null}
      {needRefresh ? (
        <Banner
          tone="info"
          message={t("app.updateAvailable")}
          actionLabel={t("app.updateAction")}
          onAction={reload}
          onDismiss={dismiss}
        />
      ) : null}
      {book ? <Shell /> : <OnboardingScreen />}
    </>
  );
}
