import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * Two languages, no more — this is a toggle, not an open-ended locale system.
 * Every UI file owns its own string table (see `Strings<K>` below) rather than
 * registering into one shared dictionary: 17 files' worth of keys in one flat
 * namespace risks a silent collision, and a per-file table gets real
 * TypeScript autocomplete/type-checking on its own keys for free.
 */
export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'xiyang-lang'

interface LangContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const LangContext = createContext<LangContextValue | null>(null)

function detectInitialLang(): Lang {
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
  return stored === 'en' ? 'en' : 'zh' // the game's native language, not the browser's
}

/**
 * The current language, for code that runs outside a component and so has no
 * `useLang()` to reach for — the zustand store and the socket layer, both of
 * which build user-facing error strings from plain functions. Reads the same
 * storage key `LangProvider` writes, so it agrees with whatever the toggle
 * last set without the two needing to coordinate any other way.
 */
export function getCurrentLang(): Lang {
  return detectInitialLang()
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang)

  const setLang = (next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // localStorage can throw in private-browsing / storage-disabled
      // contexts; the toggle still works for the session, it just won't
      // persist across reloads.
    }
  }

  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang() called outside <LangProvider>')
  return ctx
}

/**
 * `{{var}}` interpolation, named rather than positional — so a template can
 * place the value wherever ITS language's word order needs it, instead of
 * both languages being forced into the same sentence shape.
 */
export function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  )
}

/** The shape every per-file string table satisfies: same keys, both languages. */
export type Strings<K extends string> = Record<Lang, Record<K, string>>
