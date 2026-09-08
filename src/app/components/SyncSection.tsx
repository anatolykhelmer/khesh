import { useTranslation } from "react-i18next";
import type { LedgerErrorCode } from "../../kernel/errors";
import { errorMessage } from "../../service/error-messages";
import { formatRelativeTime } from "../format";
import { useSync } from "../sync/sync-context";

/** Codes whose generic `errors.*` line is too thin for this screen. Settings is where
 * the user can actually act, so these say what to do instead of only what happened. */
const SPECIFIC_ERROR_KEYS: Partial<Record<LedgerErrorCode, string>> = {
  SYNC_FORMAT_UNSUPPORTED: "sync.errorUpdateApp",
  SYNC_FILE_MISSING: "sync.errorFileMissing",
  SYNC_FILE_AMBIGUOUS: "sync.errorFileAmbiguous",
};

/** The Settings "Sync" block: connect button, first-connect choice, status,
 * manual-resolution actions. Renders nothing when no OAuth client id is built in. */
export function SyncSection() {
  const { t, i18n } = useTranslation();
  const sync = useSync();

  if (!sync.configured) return null;

  const when =
    sync.state?.lastSyncAt != null
      ? formatRelativeTime(new Date(sync.state.lastSyncAt).getTime(), Date.now(), i18n.language)
      : t("sync.neverSynced");

  if (sync.pendingInspection !== null) {
    const inspection = sync.pendingInspection;
    return (
      <>
        <h2 className="section-label">{t("sync.title")}</h2>
        <ul className="settings-list group">
          <li className="settings-row">
            <p>{t("sync.choiceTitle")}</p>
            {inspection.kind === "book" ? (
              <>
                <p className="muted row-hint">
                  {t("sync.choiceBody", { name: inspection.name, entries: inspection.entryCount })}
                </p>
                <button type="button" className="row-button" disabled={sync.applying} onClick={() => void sync.applyChoice("useRemote")}>
                  {t("sync.choiceUseRemote")}
                </button>
                <button type="button" className="row-button" disabled={sync.applying} onClick={() => void sync.applyChoice("merge")}>
                  {t("sync.choiceMerge")}
                </button>
                <p className="muted row-hint">{t("sync.choiceMergeWarning")}</p>
                <button type="button" className="row-button" disabled={sync.applying} onClick={() => void sync.applyChoice("replaceRemote")}>
                  {t("sync.choiceReplaceRemote")}
                </button>
              </>
            ) : inspection.kind === "unreadable" && inspection.errorCode === "SYNC_ENVELOPE_INVALID" ? (
              <>
                <p className="muted row-hint">{t("sync.choiceUnreadable")}</p>
                <button type="button" className="row-button" disabled={sync.applying} onClick={() => void sync.applyChoice("replaceRemote")}>
                  {t("sync.choiceReplaceRemote")}
                </button>
              </>
            ) : (
              <p className="muted row-hint">{t("sync.errorUpdateApp")}</p>
            )}
            <button type="button" className="row-button" onClick={sync.cancelConnect}>
              {t("common.cancel")}
            </button>
            {sync.lastError !== null ? <p className="muted row-hint">{sync.lastError}</p> : null}
          </li>
        </ul>
      </>
    );
  }

  if (!sync.connected) {
    return (
      <>
        <h2 className="section-label">{t("sync.title")}</h2>
        <ul className="settings-list group">
          <li className="settings-row">
            <button type="button" className="row-button" disabled={sync.applying} onClick={() => void sync.connect()}>
              {t("sync.connect")}
            </button>
            <p className="muted row-hint">{t("sync.connectHint")}</p>
            {sync.lastError !== null ? <p className="muted row-hint">{sync.lastError}</p> : null}
          </li>
        </ul>
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
      default:
        return { label: t("sync.statusSynced"), hint: null, alert: false };
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
      <ul className="settings-list group">
        <li className="settings-row">
          <p>{t("sync.conflictTitle")}</p>
          <p className="muted row-hint">{t("sync.conflictBody")}</p>
          <button type="button" className="row-button" onClick={sync.resolveUseLocal}>
            {t("sync.useLocal")}
          </button>
          <button type="button" className="row-button" onClick={sync.resolveUseRemote}>
            {t("sync.useRemote")}
          </button>
        </li>
      </ul>
    ) : null;

  return (
    <>
      <h2 className="section-label">{t("sync.title")}</h2>
      <ul className="settings-list group">
        <li className="settings-row sync-status">
          <p className="sync-line">
            <span className={status.alert ? "sync-state alert" : "sync-state"}>
              {status.label}
            </span>
            <span className="sync-when muted">{when}</span>
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
              disabled={sync.applying}
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
          <button type="button" className="row-button" onClick={() => void sync.disconnect()}>
            {t("sync.disconnect")}
          </button>
          <p className="muted row-hint">{t("sync.disconnectHint")}</p>
        </li>
      </ul>
    </>
  );
}
