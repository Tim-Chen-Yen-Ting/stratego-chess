import { useEffect, useMemo } from 'react'
import { Create } from './screens/Create.js'
import { Setup } from './screens/Setup.js'
import { Game } from './screens/Game.js'
import { useStore } from './store.js'
import { parseToken } from './url.js'

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

  useEffect(() => {
    if (token) connect(token)
  }, [token, connect])

  if (!token) return <Create />

  return (
    <>
      {error && (
        <div className="toast" role="alert">
          {error}
          <button type="button" onClick={clearError} aria-label="關閉">
            ×
          </button>
        </div>
      )}
      {connection === 'closed' && <div className="toast warn">連線中斷，重新連線中…（讀秒持續進行）</div>}

      {!view ? (
        <main className="screen">
          <h1>行軍西洋棋</h1>
          <p className="muted">{connection === 'connecting' ? '連線中…' : '等待伺服器狀態…'}</p>
        </main>
      ) : view.status.kind === 'setup' ? (
        <Setup view={view} />
      ) : (
        <Game view={view} />
      )}
    </>
  )
}
