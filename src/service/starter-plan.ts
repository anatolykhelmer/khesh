import type { AccountType, CurrencyCode } from "../kernel";
import type { Answers } from "../app/onboarding/questionnaire";

/**
 * One account the starter wizard will create. `nameKey` is an i18n key (with optional
 * interpolation args) resolved by `createHousehold` at creation time in the language the
 * user chose, the same way `ROOT_SEEDS` resolve the root names. Keeping the key rather
 * than the string here is what makes this module pure and its tests language-independent.
 *
 * `key` is unique within a plan and is what `parentKey` points at; the list is always
 * ordered parents-first so a single pass can mint ids.
 */
export type StarterAccount = {
  key: string;
  parentKey: string | null;
  nameKey: string;
  nameArgs?: Record<string, string | number>;
  type: AccountType;
  isPlaceholder: boolean;
  currency: CurrencyCode;
};

export type StarterNode = StarterAccount & { children: StarterNode[] };

export function rootsPlan(homeCurrency: CurrencyCode): StarterAccount[] {
  const root = (key: string, nameKey: string, type: AccountType): StarterAccount => ({
    key, parentKey: null, nameKey, type, isPlaceholder: true, currency: homeCurrency,
  });
  return [
    root("assets", "accounts.rootAssets", "asset"),
    root("liabilities", "accounts.rootLiabilities", "liability"),
    root("income", "accounts.rootIncome", "income"),
    root("expenses", "accounts.rootExpenses", "expense"),
  ];
}

const NAME = "starter.accounts.";

export function planStarterBook(a: Answers, homeCurrency: CurrencyCode): StarterAccount[] {
  const plan = rootsPlan(homeCurrency);
  if (a.household === null || a.household === "skip") return plan;

  const groups = new Set<string>();
  /** Add a leaf (or a group with `group: true`) under `parentKey`; `key` must be unique. */
  const add = (
    parentKey: string,
    key: string,
    name: string,
    opts: { group?: boolean; currency?: CurrencyCode; args?: Record<string, string | number> } = {},
  ) => {
    // Every entry inherits its parent's type; the roots carry theirs from rootsPlan.
    const parent = plan.find((p) => p.key === parentKey)!;
    plan.push({
      key,
      parentKey,
      nameKey: NAME + name,
      ...(opts.args ? { nameArgs: opts.args } : {}),
      type: parent.type,
      isPlaceholder: opts.group === true,
      currency: opts.currency ?? homeCurrency,
    });
    if (opts.group) groups.add(key);
  };
  const group = (parentKey: string, key: string, name: string) => {
    if (!groups.has(key)) add(parentKey, key, name, { group: true });
  };

  // Assets
  if (a.money.includes("cash")) add("assets", "cash", "cash");
  if (a.money.includes("bank")) {
    add("assets", "bank", "bankAccount");
    if (a.secondBank === true) add("assets", "bank2", "bankAccountN", { args: { n: 2 } });
  }
  if (a.money.includes("savings")) add("assets", "savings", "savings");
  if (a.money.includes("fx") && a.fxCurrency !== null) {
    add("assets", "fx", "fxAccount", { currency: a.fxCurrency, args: { currency: a.fxCurrency } });
  }

  // Liabilities
  if (a.money.includes("card") && a.cardCount !== null) {
    add("liabilities", "card", "creditCard");
    for (let n = 2; n <= a.cardCount; n++) add("liabilities", `card${n}`, "creditCardN", { args: { n } });
  }
  if (a.housing === "mortgage") add("liabilities", "mortgage", "mortgage");
  if (a.transport.includes("car") && a.carLoan === true) add("liabilities", "carLoan", "carLoan");

  // Income
  if (a.income.includes("salary")) add("income", "salary", "salary");
  if (a.income.includes("salary2")) add("income", "salary2", "salaryN", { args: { n: 2 } });
  if (a.income.includes("freelance")) add("income", "freelance", "freelance");
  if (a.income.includes("benefits")) add("income", "benefits", "benefits");
  if (a.income.includes("rental")) add("income", "rental", "rentReceived");
  if (a.income.includes("investments")) add("income", "investments", "investments");

  // Expenses
  add("expenses", "groceries", "groceries");
  if (a.housing !== null && a.housing !== "family") {
    group("expenses", "housing", "housing");
    if (a.housing === "rent") add("housing", "rent", "rent");
    if (a.housing === "mortgage") add("housing", "mortgageInterest", "mortgageInterest");
    add("housing", "utilities", "utilities");
    add("housing", "homeRepairs", "homeRepairs");
    if (a.buildingFees === true) add("housing", "buildingFees", "buildingFees");
  }
  if (a.transport.includes("car") || a.transport.includes("lease")) {
    group("expenses", "car", "car");
    if (a.transport.includes("car")) {
      add("car", "fuel", "fuel");
      add("car", "carInsurance", "carInsurance");
      add("car", "carRepairs", "carRepairs");
      add("car", "parking", "parking");
    }
    if (a.transport.includes("lease")) {
      add("car", "lease", "lease");
      if (!a.transport.includes("car")) add("car", "fuel", "fuel");
    }
  }
  if (a.transport.includes("public")) add("expenses", "publicTransport", "publicTransport");
  if (a.household === "family") {
    group("expenses", "children", "children");
    if (a.childAges.includes("under3")) add("children", "daycare", "daycare");
    if (a.childAges.includes("school")) {
      add("children", "school", "school");
      add("children", "activities", "activities");
    }
    if (a.childAges.includes("student")) add("children", "tuition", "tuition");
    add("children", "childrenClothing", "childrenClothing");
  }
  if (a.income.includes("freelance") && a.trackBusiness === true) {
    group("expenses", "business", "business");
    add("business", "businessExpenses", "businessExpenses");
  }
  for (const extra of a.extras) add("expenses", extra, extra);
  add("expenses", "other", "other");

  return plan;
}

export function planTree(plan: readonly StarterAccount[]): StarterNode[] {
  const build = (parentKey: string | null): StarterNode[] =>
    plan.filter((p) => p.parentKey === parentKey).map((p) => ({ ...p, children: build(p.key) }));
  return build(null);
}
