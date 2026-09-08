import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLedger } from "../ledger-context";
import { performReset } from "../reset-flow";
import { useSync } from "../sync/sync-context";

/** The Settings danger zone: erase the book on this device and disconnect Drive sync,
 * behind a confirmation the screen owns rather than `confirm()`. The browser dialog is
 * suppressed in the preview automation this app is verified in, which is how every other
 * destructive flow here shipped unexercised; real buttons can be driven.
 *
 * This component only renders and owns `confirming`/`busy` — the disconnect → erase →
 * announce sequence itself lives in `performReset` (`../reset-flow`), which is plain
 * TypeScript and has its own tests. */
export function DangerZone() {
  const { t } = useTranslation();
  const { app, announceBookChanged, setError } = useLedger();
  const sync = useSync();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The ref is the guard and `busy` is what the UI reads: a second tap on this, the
  // app's most destructive button, can arrive before React re-renders with `busy` —
  // same pattern as SyncProvider's `applyingRef`.
  const busyRef = useRef(false);

  async function onReset() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await performReset({
        sync,
        resetAll: () => app.resetAll(),
        announceBookChanged,
        setError,
      });
    } finally {
      busyRef.current = false;
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
