import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FirstConnectChoice } from "../../service/sync-connect";
import { useLedger } from "../ledger-context";
import { needsConfirmation } from "../sync/destructive-choice-rule";
import { useSync } from "../sync/sync-context";

/** The label and hint for each choice. One place, so every screen that offers a choice
 * words it the same way. */
const CHOICE_KEYS: Record<FirstConnectChoice, { label: string; hint: string }> = {
  useRemote: { label: "sync.choiceUseRemote", hint: "sync.choiceUseRemoteHint" },
  merge: { label: "sync.choiceMerge", hint: "sync.choiceMergeWarning" },
  replaceRemote: { label: "sync.choiceReplaceRemote", hint: "sync.choiceReplaceRemoteHint" },
};

/** The second screen a destructive choice gets, for the two that `needsConfirmation`
 * names. `merge` is absent rather than mapped to empty strings: it deletes nothing, and
 * a key that exists would invite a future caller to render it. */
const CONFIRM_KEYS: Partial<Record<FirstConnectChoice, { warning: string; confirm: string }>> = {
  useRemote: { warning: "sync.confirmUseRemoteWarning", confirm: "sync.confirmUseRemoteYes" },
  replaceRemote: {
    warning: "sync.confirmReplaceRemoteWarning",
    confirm: "sync.confirmReplaceRemoteYes",
  },
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
 *
 * `disabled` is the host screen's own busy state — a save, an import, a start-over. Those
 * writes and a first connect are mutually exclusive: an in-flight `useRemote` that lands
 * after a seed was written uploads the seed over the adopted book, and one that lands
 * after a start-over re-arms the connection that start-over just tore down. The screen
 * owns that flag because only it knows what else it is running; this component adds
 * `sync.applying` to it and gates every button, Cancel included.
 */
export function ConnectDrive({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const { book } = useLedger();
  const sync = useSync();
  const [confirming, setConfirming] = useState<FirstConnectChoice | null>(null);

  // Which choice the user dispatched, so only that button says it is working. Paired
  // with `sync.applying` at every read, never trusted alone: a failed apply leaves the
  // stage `choosing` and the inspection unchanged, so the reset effect below never fires
  // and a label keyed on this alone would sit at "Working…" over a re-enabled button.
  const [running, setRunning] = useState<FirstConnectChoice | null>(null);

  // A pending confirmation belongs to the plan it was opened against. `pendingInspection`
  // is a fresh object per connect and null between them, so this clears the expanded row
  // when the plan is cancelled, applied or replaced — otherwise the next Connect would
  // open with a stale "are you sure" already unfolded. `running` tracks the same window,
  // and clearing it here prevents a stale "Working…" label from carrying into the next
  // choice screen.
  const inspection = sync.pendingInspection;
  useEffect(() => {
    setConfirming(null);
    setRunning(null);
  }, [inspection]);

  if (!sync.configured) return null;

  // Cancel is on this list: it only drops the choice screen, so leaving it live during an
  // apply let the user dismiss the UI while the write it started ran on to completion.
  const blocked = disabled || sync.applying;

  if (inspection === null) {
    return (
      <ul className="settings-list group">
        <li className="settings-row">
          <button
            type="button"
            className="row-button"
            disabled={blocked}
            onClick={() => void sync.connect()}
          >
            {t(sync.applying ? "sync.connecting" : "sync.connect")}
          </button>
          <p className="muted row-hint">
            {t(book === null ? "sync.connectRestoreHint" : "sync.connectHint")}
          </p>
          {/* The one thing this row cannot leave unsaid: the choices the user tapped
              Connect for were dropped because the book moved underneath them, so Connect
              looks like it did nothing. Neutral, not `alert` — nothing broke and nothing
              was lost, and in the commonest case (onboarding's Continue) the user did
              exactly what the previous red line asked for. `role="status"` because the
              screen changes with no focus move. */}
          {sync.planWasDropped ? (
            <p className="muted row-hint" role="status">
              {t("sync.planDropped")}
            </p>
          ) : null}
          {sync.lastError !== null ? <p className="row-hint alert">{sync.lastError}</p> : null}
        </li>
      </ul>
    );
  }

  const plan = sync.pendingPlan;
  const plannedFor = sync.pendingLocalState;
  // What the remote costs, for the copy that has to name it. Only a readable book has a
  // name and a count; the other kinds interpolate nothing.
  const remoteDetail =
    inspection.kind === "book" ? { name: inspection.name, entries: inspection.entryCount } : {};

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
            <p className="muted row-hint">{t("sync.choiceBody", remoteDetail)}</p>
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

        {plan !== null && plan.kind === "choose" && plannedFor !== null
          ? plan.choices.map((choice) => {
              const confirmKeys = CONFIRM_KEYS[choice];
              // The hint for uploading over a real Drive book names what is deleted.
              // "The copy in Drive is replaced" is true of an unreadable remote too, where
              // there is nothing to lose; over a book it is the whole cost in a clause.
              const hint =
                choice === "replaceRemote" && inspection.kind === "book"
                  ? t("sync.choiceReplaceRemoteHintBook", remoteDetail)
                  : t(CHOICE_KEYS[choice].hint);

              if (confirming === choice && confirmKeys !== undefined) {
                return (
                  <li className="settings-row" key={choice}>
                    <p className="row-hint alert">{t(confirmKeys.warning, remoteDetail)}</p>
                    <div className="button-row">
                      <button
                        type="button"
                        className="danger"
                        disabled={blocked}
                        onClick={() => {
                          setRunning(choice);
                          void sync.applyChoice(choice);
                        }}
                      >
                        {t(
                          running === choice && sync.applying
                            ? "sync.applyingChoice"
                            : confirmKeys.confirm,
                        )}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={blocked}
                        onClick={() => setConfirming(null)}
                      >
                        {t("common.cancel")}
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li className="settings-row" key={choice}>
                  <button
                    type="button"
                    className="row-button"
                    disabled={blocked}
                    onClick={() => {
                      if (needsConfirmation(choice, inspection, plannedFor)) {
                        setConfirming(choice);
                        return;
                      }
                      setRunning(choice);
                      void sync.applyChoice(choice);
                    }}
                  >
                    {t(
                      running === choice && sync.applying
                        ? "sync.applyingChoice"
                        : CHOICE_KEYS[choice].label,
                    )}
                  </button>
                  <p className="muted row-hint">{hint}</p>
                </li>
              );
            })
          : null}

        {sync.lastError !== null ? (
          <li className="settings-row">
            <p className="row-hint alert">{sync.lastError}</p>
          </li>
        ) : null}
      </ul>
      <ul className="settings-list group">
        <li className="settings-row">
          <button
            type="button"
            className="row-button"
            disabled={blocked}
            onClick={sync.cancelConnect}
          >
            {t("common.cancel")}
          </button>
        </li>
      </ul>
    </>
  );
}
