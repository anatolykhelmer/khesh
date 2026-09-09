import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectDrive } from "../components/ConnectDrive";
import { ImportBookButton } from "../components/ImportBookButton";
import { errorMessage } from "../../service/error-messages";
import { useLedger } from "../ledger-context";
import { performStartOver } from "../reset-flow";
import { useSync } from "../sync/sync-context";

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
 *
 * The start-over sequence itself — disconnect Drive, then clear the boot error — lives in
 * `performStartOver` (`../reset-flow`), which is plain TypeScript and has its own tests,
 * the same split `DangerZone` uses.
 */
export function RecoveryScreen() {
  const { t } = useTranslation();
  const { bootError, retryBoot, startOver, setError } = useLedger();
  const sync = useSync();
  const [confirming, setConfirming] = useState(false);
  // The import button drives its own async work; while it runs, start over — which now
  // disconnects Drive — must not fire underneath a book that is about to be restored.
  const [importing, setImporting] = useState(false);
  const [startingOver, setStartingOver] = useState(false);
  // The ref is the guard and `startingOver` is what the UI reads: a second tap can arrive
  // before React re-renders — same pattern as `DangerZone` and `SyncProvider.applyingRef`.
  const busyRef = useRef(false);

  async function onStartOver() {
    if (busyRef.current) return;
    busyRef.current = true;
    setStartingOver(true);
    try {
      await performStartOver({ sync, startOver, setError });
    } finally {
      busyRef.current = false;
      setStartingOver(false);
    }
  }

  if (bootError === "STORAGE_UNAVAILABLE") {
    return (
      <main className="screen">
        <p className="brand">Khesh</p>
        <h1>{t("recovery.storageTitle")}</h1>
        <p className="muted">{t("recovery.storageBody")}</p>
        <ul className="settings-list group">
          <li className="settings-row">
            {/* No busy state here: `retryBoot` sets `loading` synchronously, so `status`
                flips to "loading" and `App` unmounts this screen in the same commit — a
                `disabled` flag could never paint, and a second tap only re-reads. */}
            <button type="button" className="row-button" onClick={() => void retryBoot()}>
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
                <button
                  type="button"
                  className="danger"
                  disabled={startingOver || importing}
                  onClick={() => void onStartOver()}
                >
                  {t("recovery.startOverConfirm")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={startingOver}
                  onClick={() => setConfirming(false)}
                >
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
