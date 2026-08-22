import { useEffect, useMemo } from 'react'
import { Create } from './screens/Create.js'
import { Setup } from './screens/Setup.js'
import { Game } from './screens/Game.js'
import { useStore } from './store.js'
import { parseToken } from './url.js'
import { useLang, type Strings } from './i18n.js'
import { LangToggle } from './components/LangToggle.js'

const STR = {
  zh: {
    close: '關閉',
    reconnecting: '連線中斷，重新連線中…（讀秒持續進行）',
    title: '行軍西洋棋',
    connecting: '連線中…',
    waiting: '等待伺服器狀態…',
  },
  en: {
    close: 'Close',
    reconnecting: 'Connection lost, reconnecting… (the clock keeps running)',
    title: 'Marching Chess',
    connecting: 'Connecting…',
    waiting: 'Waiting for server state…',
  },
} satisfies Strings<'close' | 'reconnecting' | 'title' | 'connecting' | 'waiting'>

/**
 * Routing (techspec §7). There are only two routes in practice: "no token in
 * the URL" → Create, and "a token" → join that game and render whichever
 * screen the server's status says we are in. The token is the only auth (§5).
 */
export function App() {
  const token = useMemo(() => parseToken(window.location), [])
  const connect = useStore((s) => s.connect)
  const connection = useStore((s) => s.connection)
  const view = useStore((s) => s.view)
  const error = useStore((s) => s.error)
  const clearError = useStore((s) => s.clearError)
  const { lang } = useLang()
  const s = STR[lang]

  useEffect(() => {
    if (token) connect(token)
  }, [token, connect])

  if (!token) return (
    <>
      <LangToggle />
      <Create />
    </>
  )

  return (
    <>
      <LangToggle />
      {error && (
        <div className="toast" role="alert">
          {error}
          <button type="button" onClick={clearError} aria-label={s.close}>
            ×
          </button>
        </div>
      )}
      {connection === 'closed' && <div className="toast warn">{s.reconnecting}</div>}

      {!view ? (
        <main className="screen">
          <h1>{s.title}</h1>
          <p className="muted">{connection === 'connecting' ? s.connecting : s.waiting}</p>
        </main>
      ) : view.status.kind === 'setup' ? (
        <Setup view={view} />
      ) : (
        <Game view={view} />
      )}
    </>
  )
}
