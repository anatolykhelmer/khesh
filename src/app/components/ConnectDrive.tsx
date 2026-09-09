import { useTranslation } from "react-i18next";
import type { FirstConnectChoice } from "../../service/sync-connect";
import { useLedger } from "../ledger-context";
import { useSync } from "../sync/sync-context";

/** The label and hint for each choice. One place, so every screen that offers a choice
 * words it the same way. */
const CHOICE_KEYS: Record<FirstConnectChoice, { label: string; hint: string }> = {
  useRemote: { label: "sync.choiceUseRemote", hint: "sync.choiceUseRemoteHint" },
  merge: { label: "sync.choiceMerge", hint: "sync.choiceMergeWarning" },
  replaceRemote: { label: "sync.choiceReplaceRemote", hint: "sync.choiceReplaceRemoteHint" },
};

const EXPLAIN_KEYS = {
  remoteEmpty: "sync.explainRemoteEmpty",
  remoteUnreadable: "sync.explainRemoteUnreadable",
  updateApp: "sync.errorUpdateApp",
} as const;

/**
 * Connecting Google Drive, wherever the app can offer it: the Settings section, the
 * onboarding screen and the recovery screen.
 *
 * It lives outside `SyncSection` because the two screens that need it most render
 * outside `Shell` — a user with no book cannot reach Settings, which is exactly the
 * state in which "connect and take the copy from Drive" is the right answer (BL-043).
 *
 * Which choices appear is `firstConnectOptions`', decided when the remote was inspected
 * and carried on `sync.pendingPlan`. This component only renders it.
 */
export function ConnectDrive() {
  const { t } = useTranslation();
  const { book } = useLedger();
  const sync = useSync();

  if (!sync.configured) return null;

  if (sync.pendingInspection === null) {
    return (
      <ul className="settings-list group">
        <li className="settings-row">
          <button
            type="button"
            className="row-button"
            disabled={sync.applying}
            onClick={() => void sync.connect()}
          >
            {t("sync.connect")}
          </button>
          <p className="muted row-hint">
            {t(book === null ? "sync.connectRestoreHint" : "sync.connectHint")}
          </p>
          {sync.lastError !== null ? <p className="row-hint alert">{sync.lastError}</p> : null}
        </li>
      </ul>
    );
  }

  const inspection = sync.pendingInspection;
  const plan = sync.pendingPlan;

  // "A book was found in your Google Drive" is only true when one was. Every other
  // case — an empty Drive, a payload that would not decode, a newer format — falls back
  // to the section's plain name.
  const heading = inspection.kind === "book" ? "sync.choiceTitle" : "sync.title";

  return (
    <>
      <h2 className="section-label statement">{t(heading)}</h2>
      <ul className="settings-list group">
        {inspection.kind === "book" ? (
          <li className="settings-row">
            <p className="muted row-hint">
              {t("sync.choiceBody", { name: inspection.name, entries: inspection.entryCount })}
            </p>
          </li>
        ) : null}
        {inspection.kind === "unreadable" && plan !== null && plan.kind === "choose" ? (
          <li className="settings-row">
            <p className="muted row-hint">{t("sync.choiceUnreadable")}</p>
          </li>
        ) : null}

        {plan !== null && plan.kind === "explain" ? (
          <li className="settings-row">
            <p className="row-hint alert">{t(EXPLAIN_KEYS[plan.reason])}</p>
          </li>
        ) : null}

        {plan !== null && plan.kind === "choose"
          ? plan.choices.map((choice) => (
              <li className="settings-row" key={choice}>
                <button
                  type="button"
                  className="row-button"
                  disabled={sync.applying}
                  onClick={() => void sync.applyChoice(choice)}
                >
                  {t(CHOICE_KEYS[choice].label)}
                </button>
                <p className="muted row-hint">{t(CHOICE_KEYS[choice].hint)}</p>
              </li>
            ))
          : null}

        {sync.lastError !== null ? (
          <li className="settings-row">
            <p className="row-hint alert">{sync.lastError}</p>
          </li>
        ) : null}
      </ul>
      <ul className="settings-list group">
        <li className="settings-row">
          <button type="button" className="row-button" onClick={sync.cancelConnect}>
            {t("common.cancel")}
          </button>
        </li>
      </ul>
    </>
  );
}
