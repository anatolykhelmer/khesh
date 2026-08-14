export type AppLanguage = "en" | "he";

function isAppLanguage(value: string | null): value is AppLanguage {
  return value === "en" || value === "he";
}

export function resolveInitialLanguage(
  stored: string | null,
  browserLanguage: string | undefined,
): AppLanguage {
  if (isAppLanguage(stored)) return stored;
  if (browserLanguage?.toLowerCase().startsWith("he")) return "he";
  return "en";
}

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import he from "./locales/he.json";

export const LANGUAGE_STORAGE_KEY = "khesh:lang";

function readStoredLanguage(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readBrowserLanguage(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

export function applyDocumentDirection(language: AppLanguage): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "he" ? "rtl" : "ltr";
}

export function setLanguage(language: AppLanguage): void {
  void i18next.changeLanguage(language);
  applyDocumentDirection(language);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    }
  } catch {
    // Storage may be unavailable (private browsing); the choice still applies this session.
  }
}

const initialLanguage = resolveInitialLanguage(readStoredLanguage(), readBrowserLanguage());

// No backend and no language-detector plugin means i18next resolves this synchronously —
// t() works immediately below without awaiting the returned promise.
void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, he: { translation: he } },
  lng: initialLanguage,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

applyDocumentDirection(initialLanguage);

export default i18next;
