import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectDrive } from "../components/ConnectDrive";
import { ImportBookButton } from "../components/ImportBookButton";
import { errorMessage } from "../../service/error-messages";
import { useLedger } from "../ledger-context";

/**
 * What the app shows when a book is stored but `boot()` could not produce one.
 *
 * It exists because the alternative was onboarding, whose Continue writes a fresh book
 * over the same key — a validation failure used to leave the user one tap from
 * overwriting their ledger, on a screen that invited the tap (BL-023).
 *
 * Two branches, because the two ways `boot()` can fail need opposite advice. Storage
 * being unreachable says nothing about the book; every recovery action ends in a write to
 * that same storage, so offering them would promise what cannot work.
 */
export function RecoveryScreen() {
  const { t } = useTranslation();
  const { bootError, retryBoot, startOver } = useLedger();
  const [retrying, setRetrying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(false);

  if (bootError === "STORAGE_UNAVAILABLE") {
    return (
      <main className="screen">
        <p className="brand">Khesh</p>
        <h1>{t("recovery.storageTitle")}</h1>
        <p className="muted">{t("recovery.storageBody")}</p>
        <ul className="settings-list group">
          <li className="settings-row">
            <button
              type="button"
              className="row-button"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void retryBoot().finally(() => setRetrying(false));
              }}
            >
              {t("recovery.retry")}
            </button>
          </li>
        </ul>
      </main>
    );
  }

  return (
    <main className="screen">
      <p className="brand">Khesh</p>
      <h1>{t("recovery.brokenTitle")}</h1>
      <p className="muted">{t("recovery.brokenBody")}</p>
      {bootError !== null ? <p className="row-hint alert">{errorMessage(bootError)}</p> : null}

      <ImportBookButton
        label={t("onboarding.restore")}
        disabled={importing}
        onBusyChange={setImporting}
      />

      <ConnectDrive />

      <ul className="settings-list group">
        <li className="settings-row">
          {confirming ? (
            <>
              <p className="muted row-hint">{t("recovery.startOverWarning")}</p>
              <div className="button-row">
                <button type="button" className="danger" onClick={startOver}>
                  {t("recovery.startOverConfirm")}
                </button>
                <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                  {t("common.cancel")}
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="row-button danger"
                onClick={() => setConfirming(true)}
              >
                {t("recovery.startOver")}
              </button>
              <p className="muted row-hint">{t("recovery.startOverHint")}</p>
            </>
          )}
        </li>
      </ul>
    </main>
  );
}
