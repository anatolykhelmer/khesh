import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LedgerErrorCode } from "../../kernel/errors";
import { errorMessage } from "../../service/error-messages";
import { relativeSyncTime } from "../format";
import { useSync } from "../sync/sync-context";
import { ConnectDrive } from "./ConnectDrive";

/** Codes whose generic `errors.*` line is too thin for this screen. Settings is where
 * the user can actually act, so these say what to do instead of only what happened. */
const SPECIFIC_ERROR_KEYS: Partial<Record<LedgerErrorCode, string>> = {
  SYNC_FORMAT_UNSUPPORTED: "sync.errorUpdateApp",
  SYNC_FILE_MISSING: "sync.errorFileMissing",
  SYNC_FILE_AMBIGUOUS: "sync.errorFileAmbiguous",
};

/**
 * The Settings "Sync" block: connect button, first-connect choice, status,
 * manual-resolution actions. Renders nothing when no OAuth client id is built in.
 *
 * `disabled` is the screen's own erase — `DangerZone`'s `busy`, lifted through
 * `SettingsScreen`. Settings is the screen that renders a first connect and the erase as
 * siblings, and until now only one of them knew about the other: `DangerZone` gates its
 * button on `sync.applying` and a plan being on screen, while every Connect here stayed
 * live for the whole of `performReset`. That gap is not theoretical. `performReset` awaits
 * `disconnect()` first, and the tail of that writes `connected: false` — so for the whole
 * of `resetAll()` this block renders its `!connected` branch with an enabled Connect row,
 * and a connect finalizing into that window arms an engine at the user's real Drive file
 * while the book is being erased out from under it (BL-040). `RecoveryScreen` and
 * `OnboardingScreen` have passed this union into `ConnectDrive` since BL-049; Settings is
 * the screen that never got it. Nothing in the provider can substitute: the erase runs on
 * past the teardown, and `useSync()` has no way to know it is still running.
 */
export function SyncSection({ disabled = false }: { disabled?: boolean }) {
  const { t, i18n } = useTranslation();
  const sync = useSync();
  // The other half of the same window, and this one is this component's own: `disconnect`
  // is awaited here with nothing gating the rows underneath it. On a `SYNC_FILE_MISSING`
  // state the connected view stays up for the whole teardown — `connected` goes false only
  // at its tail — and the Reconnect row below is disabled by `sync.applying` alone, so a
  // tap runs a fresh `connect()` against a connection this tab is in the middle of
  // dropping. Ref plus state for the reason the rest of the app uses it: a second tap
  // arrives before React has re-rendered.
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectingRef = useRef(false);

  async function onDisconnect() {
    if (disconnectingRef.current) return;
    disconnectingRef.current = true;
    setDisconnecting(true);
    try {
      await sync.disconnect();
    } finally {
      disconnectingRef.current = false;
      setDisconnecting(false);
    }
  }

  if (!sync.configured) return null;

  // Everything in this block that starts or re-starts a connection is blocked by both.
  const blocked = disabled || disconnecting;

  const when = relativeSyncTime(sync.state?.lastSyncAt ?? null, Date.now(), i18n.language);

  if (sync.pendingInspection !== null || !sync.connected) {
    return (
      <>
        {sync.pendingInspection === null ? (
          <h2 className="section-label">{t("sync.title")}</h2>
        ) : null}
        {/* `ConnectDrive` adds `sync.applying` itself. */}
        <ConnectDrive disabled={blocked} />
      </>
    );
  }

  const status = (() => {
    switch (sync.state?.kind) {
      case "syncing":
        return { label: t("sync.syncing"), hint: null, alert: false };
      case "offline":
        // The app is offline-first: a lost connection is a described state, not a
        // fault, so it says so in words and keeps the neutral colour.
        return { label: t("sync.statusOffline"), hint: t("sync.offline"), alert: false };
      case "needsAuth":
        // No explanation line: the "Sign in" row directly below is the explanation.
        return { label: t("sync.statusNeedsAuth"), hint: null, alert: true };
      case "error": {
        const specific = SPECIFIC_ERROR_KEYS[sync.state.errorCode];
        return {
          label: t("sync.statusError"),
          hint: specific !== undefined ? t(specific) : errorMessage(sync.state.errorCode),
          alert: true,
        };
      }
      case "manualResolution":
        // Syncing is halted until the user picks which book to keep, so "Synced" over
        // the conflict card below would be the exact lie this pass exists to remove.
        return { label: t("sync.statusError"), hint: null, alert: true };
      default:
        // Also catches idle with no timestamp yet and the null window between
        // finalizeConnect's setConnected(true) and the engine's first state event —
        // neither of those is "Synced" either.
        return when !== null
          ? { label: t("sync.statusSynced"), hint: null, alert: false }
          : { label: t("sync.neverSynced"), hint: null, alert: false };
    }
  })();

  const errorCode = sync.state?.kind === "error" ? sync.state.errorCode : null;
  // Two errors no retry can clear, so "Sync now" would re-promise a retry that cannot
  // work: a newer-format remote decodes the same way every time, and a missing file is
  // a cached id that will 404 for as long as it is cached. The second one gets its own
  // button instead. Every other case (offline, needsAuth, an ambiguous search the user
  // has since tidied up in Drive) keeps Sync now; retrying there is meaningful.
  const isUnsupportedFormatError = errorCode === "SYNC_FORMAT_UNSUPPORTED";
  const isFileMissingError = errorCode === "SYNC_FILE_MISSING";

  const manualResolution =
    sync.state?.kind === "manualResolution" ? (
      <>
        <h2 className="section-label statement">{t("sync.conflictTitle")}</h2>
        <ul className="settings-list group">
          <li className="settings-row">
            <button type="button" className="row-button" onClick={sync.resolveUseLocal}>
              {t("sync.useLocal")}
            </button>
            <p className="muted row-hint">{t("sync.conflictBody")}</p>
          </li>
          <li className="settings-row">
            <button type="button" className="row-button" onClick={sync.resolveUseRemote}>
              {t("sync.useRemote")}
            </button>
            <p className="muted row-hint">{t("sync.conflictBody")}</p>
          </li>
        </ul>
      </>
    ) : null;

  return (
    <>
      <h2 className="section-label">{t("sync.title")}</h2>
      <ul className="settings-list group">
        <li className="settings-row">
          <p className="sync-line">
            <span className={status.alert ? "sync-state alert" : "sync-state"}>
              {status.label}
            </span>
            {when !== null ? <span className="sync-when muted">{when}</span> : null}
          </p>
          {sync.email !== null ? <p className="muted row-hint">{sync.email}</p> : null}
          {status.hint !== null ? (
            <p className={status.alert ? "row-hint alert" : "row-hint muted"}>{status.hint}</p>
          ) : null}
          {sync.lastError !== null ? <p className="row-hint alert">{sync.lastError}</p> : null}
        </li>
        {isFileMissingError ? (
          <li className="settings-row">
            <button
              type="button"
              className="row-button"
              disabled={sync.applying || blocked}
              onClick={() => void sync.reconnect()}
            >
              {t("sync.reconnectAction")}
            </button>
            <p className="muted row-hint">{t("sync.reconnectHint")}</p>
          </li>
        ) : null}
        {!isUnsupportedFormatError && !isFileMissingError ? (
          <li className="settings-row">
            <button
              type="button"
              className="row-button"
              disabled={sync.state?.kind === "syncing"}
              onClick={() => (sync.state?.kind === "needsAuth" ? void sync.reauth() : sync.syncNow())}
            >
              {sync.state?.kind === "needsAuth"
                ? t("sync.needsAuthAction")
                : sync.state?.kind === "syncing"
                  ? t("sync.syncing")
                  : t("sync.syncNow")}
            </button>
          </li>
        ) : null}
      </ul>
      {manualResolution}
      <ul className="settings-list group">
        <li className="settings-row">
          <button
            type="button"
            className="row-button"
            disabled={blocked}
            onClick={() => void onDisconnect()}
          >
            {t("sync.disconnect")}
          </button>
          <p className="muted row-hint">{t("sync.disconnectHint")}</p>
        </li>
      </ul>
    </>
  );
}
