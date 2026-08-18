import { useTranslation } from "react-i18next";

type Props = {
  /** True when the account is a group (placeholder). */
  value: boolean;
  onChange: (isPlaceholder: boolean) => void;
};

/** The account-vs-group radio pair shared by the account create and edit forms. */
export function AccountKindChoice({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <fieldset className="choice-group">
      <legend>{t("common.kind")}</legend>
      <label className="inline-choice">
        <input type="radio" name="kind" checked={!value} onChange={() => onChange(false)} />
        {t("common.choiceAccount")}
      </label>
      <label className="inline-choice">
        <input type="radio" name="kind" checked={value} onChange={() => onChange(true)} />
        {t("common.choiceGroup")}
      </label>
    </fieldset>
  );
}
