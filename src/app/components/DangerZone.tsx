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
 * TypeScript and has its own tests.
 *
 * No props. `busy` used to be lifted to `SettingsScreen` and handed down to `SyncSection`
 * — `ImportBookButton`'s pattern — because the erase and the Connect row are siblings on
 * one screen and each had to know the other was running, and that lift was the first hop
 * of the only guard on `performReset`'s post-teardown window: `performReset`'s own doc
 * called it "not decoration", and dropping it reopened BL-040 with the whole suite green,
 * since no test in this repo can mount a component. That prop chain's middle two hops
 * (`SettingsScreen`, `SyncSection`) were exactly the part invisible to the suite — deleting
 * both left it green regardless. `performReset` now brackets itself with
 * `sync.beginErase()`/`sync.endErase()` instead of taking a callback from its caller, and
 * `endErase()`'s own `finally` is what closes the window this component used to hold open
 * by hand: every screen reads it back through `sync.activity.blocking` (BL-055), including
 * one that mounts only after this component has already unmounted. */
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
  // Settings renders `SyncSection` — and so `ConnectDrive` — above this row, so a first
  // connect and the erase are one screen apart. Both take the sync lock, which orders them
  // but does not stop `applyFirstConnect` from saving the Drive book *after* `resetAll`
  // cleared storage, leaving the erase ending with the remote book back on disk and the app
  // already on onboarding. A plan on screen counts for the same reason it does in
  // onboarding: one tap from that write. Not `activity.blocking` — that now folds in
  // `erasing`, which this component is about to set, so gating this button on it would
  // gate the erase on its own erase.
  //
  // This is one direction of a pair, and for a long time it was the only one — the erase
  // knew about a live connect, the connect knew nothing about a live erase. The other
  // direction is `sync.beginErase()`/`endErase()` below: `activity.erasing` covers the
  // whole of `performReset`, which runs on well past the `disconnect()` it starts with,
  // and that remainder is the window a Connect could finalize into.
  const connecting =
    sync.activity.connecting || sync.activity.applying || sync.pendingInspection !== null;

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
                disabled={busy || connecting}
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
              disabled={connecting}
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
