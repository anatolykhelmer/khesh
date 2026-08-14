import { useRef, useState, type ChangeEvent } from "react";
import { errorMessage } from "../../service/error-messages";
import { useLedger } from "../ledger-context";

type Props = {
  label: string;
  /** When set, ask for confirmation before replacing the current book. */
  confirmText?: string;
  onSuccess?: () => void;
  disabled?: boolean;
  /** Notified with the component's busy state, so a parent can disable other controls during import. */
  onBusyChange?: (busy: boolean) => void;
};

export function ImportBookButton({
  label,
  confirmText,
  onSuccess,
  disabled,
  onBusyChange,
}: Props) {
  const { app, setBook, setError } = useLedger();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so picking the same file again still fires a change event.
    event.target.value = "";
    if (!file) return;
    if (confirmText !== undefined && !confirm(confirmText)) return;

    setBusy(true);
    onBusyChange?.(true);
    try {
      const result = await app.importJson(await file.text());
      if (!result.ok) {
        setError(errorMessage(result.error.code));
        return;
      }
      setError(null);
      setBook(result.value);
      onSuccess?.();
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={onFileChosen}
      />
      <button
        type="button"
        className="secondary"
        disabled={disabled === true || busy}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
    </>
  );
}
