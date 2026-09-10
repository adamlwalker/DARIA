import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import en from "../locales/en.json";

/** Session language type kept so call sites that still branch on `"zh"` compile.
 *  The running app is English-only. */
export type Lang = "zh" | "en";

/** Agent/model layer is English-only. */
export function agentLang(_lang: Lang): "zh" | "en" {
  return "en";
}

const LANG_KEY = "chaty.lang";

export type TKey = keyof typeof en;

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
}

const LangContext = createContext<I18n | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const lang: Lang = "en";

  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, "en");
    } catch {
      /* ignore */
    }
  }, []);

  const setLang = useCallback((_l: Lang) => {
    /* UI language is English-only. */
  }, []);

  const t = useCallback((key: TKey, vars?: Record<string, string | number>) => {
    let s: string = en[key] ?? key;
    if (vars) {
      for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]));
    }
    return s;
  }, []);

  const value = useMemo<I18n>(() => ({ lang, setLang, t }), [t, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useI18n must be used within LangProvider");
  return ctx;
}
