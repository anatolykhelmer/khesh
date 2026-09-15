import { useTranslation } from "react-i18next";
import type { CurrencyCode } from "../../../kernel";
import type { StarterNode } from "../../../service/starter-plan";

function Node({ node, homeCurrency }: { node: StarterNode; homeCurrency: CurrencyCode }) {
  const { t } = useTranslation();
  return (
    <li>
      <span className={node.isPlaceholder ? "starter-tree-group" : undefined}>
        {t(node.nameKey, node.nameArgs)}
        {node.currency !== homeCurrency ? ` (${node.currency})` : null}
      </span>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child) => (
            <Node key={child.key} node={child} homeCurrency={homeCurrency} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SummaryStep({
  tree,
  homeCurrency,
  busy,
  onBack,
  onCreate,
}: {
  tree: StarterNode[];
  homeCurrency: CurrencyCode;
  busy: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <h1>{t("onboarding.wizard.summaryTitle")}</h1>
      <p className="muted">{t("onboarding.wizard.summaryHint")}</p>
      <ul className="starter-tree group">
        {tree.map((node) => (
          <Node key={node.key} node={node} homeCurrency={homeCurrency} />
        ))}
      </ul>
      <div className="wizard-nav">
        <button type="button" className="secondary" disabled={busy} onClick={onBack}>
          {t("onboarding.wizard.back")}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={onCreate}>
          {t("onboarding.wizard.createBook")}
        </button>
      </div>
    </>
  );
}
