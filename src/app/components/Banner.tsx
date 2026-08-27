import { useTranslation } from "react-i18next";

type Props = {
  message: string;
  onDismiss: () => void;
  tone?: "error" | "info";
  actionLabel?: string;
  onAction?: () => void;
};

export function Banner({ message, onDismiss, tone = "error", actionLabel, onAction }: Props) {
  const { t } = useTranslation();
  const isInfo = tone === "info";
  return (
    <div className={isInfo ? "banner info" : "banner"} role={isInfo ? "status" : "alert"}>
      <span>{message}</span>
      {actionLabel && onAction ? (
        <button type="button" className="secondary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
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
