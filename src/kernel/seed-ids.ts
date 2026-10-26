/**
 * Ids for the accounts the starter wizard creates, derived from the plan key rather than
 * minted, so two devices that answered the same questions produce the same accounts and a
 * merge unifies them by construction instead of doubling the tree.
 *
 * The same idea as `sys:ob` and `sys:ob:<currency>` in `opening.ts`, with a different
 * prefix on purpose: `sys:` means "system, hidden" everywhere else in this codebase —
 * `isSystemAccountId` drops such accounts from the account tree, refuses them children and
 * hides their opening-balance action. Starter accounts are ordinary user accounts.
 *
 * A leaf carries its currency and a group does not, because a leaf can hold postings and a
 * group cannot (`entry-validation.ts` refuses a posting to a placeholder). Unifying two
 * leaves that disagree on currency would reinterpret one side's amounts — 5000 stored as
 * 50.00 ILS read back as 50.00 USD — with nothing left in the book to detect it. Groups
 * hold no amounts, so unifying them across home currencies costs nothing.
 *
 * The id never changes when the account is later renamed or its currency edited. It names
 * the account; it does not assert anything about it.
 */
const SEED_PREFIX = "seed:";

export function seedAccountId(account: {
  key: string;
  isPlaceholder: boolean;
  currency: string;
}): string {
  return account.isPlaceholder
    ? `${SEED_PREFIX}${account.key}`
    : `${SEED_PREFIX}${account.key}:${account.currency}`;
}

export function isSeedAccountId(id: string): boolean {
  return id.startsWith(SEED_PREFIX);
}
