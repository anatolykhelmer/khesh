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
  SYNC_ACCESS_REVOKED: "sync.errorAccessRevoked",
};

/**
 * The Settings "Sync" block: connect button, first-connect choice, status,
 * manual-resolution actions. Renders nothing when no OAuth client id is built in.
 *
 * No props. This used to need `disabled` — `DangerZone`'s `busy`, lifted through
 * `SettingsScreen` — because Settings renders a first connect and the erase as siblings,
 * and until BL-055 closed only `SettingsScreen` knew both existed: `DangerZone` gated its
 * own button on a plan being on screen, while every Connect here stayed live for the whole
 * of `performReset`. That gap was not theoretical. `performReset` awaits `disconnect()`
 * first, and the tail of that writes `connected: false` — so for the whole of `resetAll()`
 * this block renders its `!connected` branch, and a connect finalizing into that window
 * arms an engine at the user's real Drive file while the book is being erased out from
 * under it (BL-040). The session now publishes `erasing` on `sync.activity` for the whole
 * of `performReset`, folded into `activity.blocking` alongside connect/apply/disconnect —
 * so this block reads the guard straight from context, the same way `ConnectDrive` reads
 * it for its own rows, and no prop has to carry it down from `SettingsScreen` at all.
 */
export function SyncSection() {
  const { t, i18n } = useTranslation();
  const sync = useSync();
  // The other half of the same window, and this one is this component's own: `disconnect`
  // is awaited here with nothing gating the rows underneath it. On a `SYNC_FILE_MISSING`
  // state the connected view stays up for the whole teardown — `connected` goes false only
  // at its tail — and the Reconnect row below would otherwise be disabled by
  // `activity.blocking` alone, so a tap runs a fresh `connect()` against a connection this
  // tab is in the middle of dropping. Ref plus state for the reason the rest of the app
  // uses it: a second tap arrives before React has re-rendered.
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

  // Everything in this block that *starts or re-starts* a connection is blocked by both.
  // Deliberately not the gate on the Disconnect row below — see its own comment.
  const blocked = sync.activity.blocking || disconnecting;

  // The Disconnect row's own gate, and the one place in this block that is not on
  // `blocking`. `blocking` folds in `connecting`, which the connected view can set itself:
  // Reconnect (the SYNC_FILE_MISSING recovery below) is the only `reconnect()` the app has,
  // and `connecting` stays true from that tap until both `getToken(true)` and
  // `inspectRemote` settle — cleared only in `runConnect`'s `finally`. A hung OAuth popup
  // or a stalled Drive read would therefore disable Disconnect with no exit but a page
  // reload. That is the counter-case the spec already settled when it rejected a teardown
  // queue: a connect that will not finish is exactly when letting go must stay possible.
  // What remains gated is what genuinely conflicts with a teardown — an erase (which runs
  // its own `disconnect()`), a teardown already in flight anywhere in the session, and this
  // component's own in-flight tap.
  const disconnectBlocked =
    sync.activity.erasing || sync.activity.disconnecting || disconnecting;

  const when = relativeSyncTime(sync.state?.lastSyncAt ?? null, Date.now(), i18n.language);

  if (sync.pendingInspection !== null || !sync.connected) {
    return (
      <>
        {sync.pendingInspection === null ? (
          <h2 className="section-label">{t("sync.title")}</h2>
        ) : null}
        {/* `ConnectDrive` reads `sync.activity.blocking` itself. */}
        <ConnectDrive />
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
        // `finalize`'s `connected = true` and the engine's first state event —
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
  // `SYNC_ACCESS_REVOKED` is deliberately *not* a third case here, though it reads like
  // one. It is mapped from a bare 403, and Drive also returns 403 for rate limits and
  // quota — which are transient and retryable. Hiding the button would dead-end every one
  // of those, for ordinary single-account users too, on the strength of a guess at what
  // the 403 meant. It keeps its own hint text (SPECIFIC_ERROR_KEYS above); what it does
  // not get is a removed escape hatch. A retry that says nothing new beats a confident
  // message with no way forward.

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
              disabled={blocked}
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
            disabled={disconnectBlocked}
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
