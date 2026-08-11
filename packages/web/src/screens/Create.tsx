import { useState } from 'react'
import { createGame, type CreatedGame } from '../socket.js'
import { localizeUrl } from '../url.js'

/**
 * Create screen (techspec §7). One button, one POST /api/game, then the two
 * links the server issued: one to share with the opponent, one to enter as
 * host. There is no matchmaking and no lobby — invite links only (§0).
 */
export function Create() {
  const [game, setGame] = useState<CreatedGame | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  async function onCreate() {
    setBusy(true)
    setError(null)
    try {
      setGame(await createGame())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      setError('無法複製，請手動選取網址。')
    }
  }

  return (
    <main className="screen screen-create">
      <h1>行軍西洋棋</h1>
      <p className="muted">
        西洋棋的載體，行軍棋的兵種。載體公開、兵種隱藏，一律大吃小；中央四格每手計分，
        軍旗離場即判負。
      </p>

      {!game && (
        <>
          <button className="primary big" type="button" onClick={onCreate} disabled={busy}>
            {busy ? '建立中…' : '建立對局'}
          </button>
          <p className="muted small">
            對局存於記憶體，伺服器重啟即消失。無帳號、無配對，僅邀請連結。
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}

      {game && (
        <section className="panel">
          <h2>對局已建立</h2>
          <p className="muted small">對局編號 {game.gameId}</p>

          <div className="link-row">
            <div className="link-label">邀請對手（分享這條）</div>
            <code className="link">{game.guestUrl}</code>
            <button type="button" onClick={() => void copy('guest', game.guestUrl)}>
              {copied === 'guest' ? '已複製' : '複製'}
            </button>
          </div>

          <div className="link-row">
            <div className="link-label">你的入口（房主）</div>
            <code className="link">{game.hostUrl}</code>
            <button type="button" onClick={() => void copy('host', game.hostUrl)}>
              {copied === 'host' ? '已複製' : '複製'}
            </button>
          </div>

          <p>
            <a className="primary big as-button" href={localizeUrl(game.hostUrl)}>
              以房主身分進入 →
            </a>
          </p>
          <p className="muted small">
            若上方分享連結的網域與此頁不同（開發模式常見），對手仍應使用伺服器發出的連結。
          </p>
        </section>
      )}
    </main>
  )
}
