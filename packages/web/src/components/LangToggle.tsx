import { useLang } from '../i18n.js'

/**
 * Always visible, same position regardless of screen (rendered once, in
 * App.tsx, above whichever screen is current) — a language choice belongs to
 * the whole session, not to one screen's state.
 */
export function LangToggle() {
  const { lang, setLang } = useLang()
  return (
    <span className="lang-toggle" role="group" aria-label="Language / 語言">
      <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>
        中文
      </button>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
        EN
      </button>
    </span>
  )
}
