import { useTranslation } from "react-i18next";
import { errorMessage } from "../../service/error-messages";
import { useSync } from "../sync/sync-context";

/** The Settings "Sync" block: connect button, first-connect choice, status,
 * manual-resolution actions. Renders nothing when no OAuth client id is built in. */
export function SyncSection() {
  const { t, i18n } = useTranslation();
  const sync = useSync();

  if (!sync.configured) return null;

  const lastSynced =
    sync.state?.lastSyncAt != null
      ? t("sync.lastSynced", { when: new Date(sync.state.lastSyncAt).toLocaleString(i18n.language) })
      : t("sync.neverSynced");

  if (sync.pendingInspection !== null) {
    const inspection = sync.pendingInspection;
    return (
      <ul className="settings-list group" aria-label={t("sync.title")}>
        <li className="settings-row">
          <p>{t("sync.choiceTitle")}</p>
          {inspection.kind === "book" ? (
            <>
              <p className="muted row-hint">
                {t("sync.choiceBody", { name: inspection.name, entries: inspection.entryCount })}
              </p>
              <button type="button" className="row-button" onClick={() => void sync.applyChoice("useRemote")}>
                {t("sync.choiceUseRemote")}
              </button>
              <button type="button" className="row-button" onClick={() => void sync.applyChoice("merge")}>
                {t("sync.choiceMerge")}
              </button>
              <p className="muted row-hint">{t("sync.choiceMergeWarning")}</p>
              <button type="button" className="row-button" onClick={() => void sync.applyChoice("replaceRemote")}>
                {t("sync.choiceReplaceRemote")}
              </button>
            </>
          ) : inspection.kind === "unreadable" && inspection.errorCode === "SYNC_ENVELOPE_INVALID" ? (
            <>
              <p className="muted row-hint">{t("sync.choiceUnreadable")}</p>
              <button type="button" className="row-button" onClick={() => void sync.applyChoice("replaceRemote")}>
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
    );
  }

  if (!sync.connected) {
    return (
      <ul className="settings-list group" aria-label={t("sync.title")}>
        <li className="settings-row">
          <button type="button" className="row-button" onClick={() => void sync.connect()}>
            {t("sync.connect")}
          </button>
          <p className="muted row-hint">{t("sync.connectHint")}</p>
          {sync.lastError !== null ? <p className="muted row-hint">{sync.lastError}</p> : null}
        </li>
      </ul>
    );
  }

  const stateLine = (() => {
    switch (sync.state?.kind) {
      case "syncing":
        return t("sync.syncing");
      case "offline":
        return t("sync.offline");
      case "needsAuth":
        return t("sync.needsAuth");
      case "error":
        return sync.state.errorCode === "SYNC_FORMAT_UNSUPPORTED"
          ? t("sync.errorUpdateApp")
          : sync.state.errorCode === "SYNC_FILE_MISSING"
            ? t("sync.errorFileMissing")
            : errorMessage(sync.state.errorCode);
      default:
        return null;
    }
  })();

  return (
    <ul className="settings-list group" aria-label={t("sync.title")}>
      <li className="settings-row">
        {sync.email !== null ? <p>{t("sync.connectedAs", { email: sync.email })}</p> : null}
        <p className="muted row-hint">{lastSynced}</p>
        {stateLine !== null ? <p className="muted row-hint">{stateLine}</p> : null}
      </li>
      {sync.state?.kind === "manualResolution" ? (
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
      ) : null}
      <li className="settings-row">
        <button
          type="button"
          className="row-button"
          disabled={sync.state?.kind === "syncing"}
          onClick={() => (sync.state?.kind === "needsAuth" ? void sync.reauth() : sync.syncNow())}
        >
          {sync.state?.kind === "needsAuth" ? t("sync.needsAuthAction") : t("sync.syncNow")}
        </button>
      </li>
      <li className="settings-row">
        <button type="button" className="row-button" onClick={() => void sync.disconnect()}>
          {t("sync.disconnect")}
        </button>
        <p className="muted row-hint">{t("sync.disconnectHint")}</p>
      </li>
    </ul>
  );
}
