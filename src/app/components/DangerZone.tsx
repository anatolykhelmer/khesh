import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../service/error-messages";
import { useLedger } from "../ledger-context";
import { useSync } from "../sync/sync-context";

/** The Settings danger zone: erase the book on this device and disconnect Drive sync,
 * behind a confirmation the screen owns rather than `confirm()`. The browser dialog is
 * suppressed in the preview automation this app is verified in, which is how every other
 * destructive flow here shipped unexercised; real buttons can be driven. */
export function DangerZone() {
  const { t } = useTranslation();
  const { app, announceBookChanged, setError } = useLedger();
  const sync = useSync();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onReset() {
    setBusy(true);
    try {
      // Disconnect first: it shuts the window in which a live engine could see empty
      // storage. The file in Drive is untouched — reconnecting reaches the usual
      // use-remote / merge / replace choice.
      if (sync.connected) await sync.disconnect();
      const result = await app.resetAll();
      if (!result.ok) {
        setError(errorMessage(result.error.code));
        return;
      }
      setError(null);
      // No book: App renders OnboardingScreen here, and the other tabs follow the
      // broadcast into the same place.
      announceBookChanged(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ul className="settings-list group">
      <li className="settings-row">
        {confirming ? (
          <>
            <p className="muted row-hint">{t("settings.resetWarning")}</p>
            <div className="button-row">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void onReset()}
              >
                {t("settings.resetConfirm")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
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
              {t("settings.resetButton")}
            </button>
            <p className="muted row-hint">{t("settings.resetHint")}</p>
          </>
        )}
      </li>
    </ul>
  );
}
