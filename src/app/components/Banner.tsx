import { useTranslation } from "react-i18next";

type Props = {
  message: string;
  onDismiss: () => void;
};

export function Banner({ message, onDismiss }: Props) {
  const { t } = useTranslation();
  return (
    <div className="banner" role="alert">
      <span>{message}</span>
      <button
        type="button"
        className="banner-dismiss"
        onClick={onDismiss}
        aria-label={t("banner.dismiss")}
      >
        ×
      </button>
    </div>
  );
}
