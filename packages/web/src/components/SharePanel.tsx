import { useEffect, useState } from 'react'

/**
 * The share links, available from inside the game.
 *
 * They used to exist only on the create screen, which meant that once you
 * navigated into your own game there was no way to get them back — close that
 * tab and the public-watch link was gone for good. Somebody asking "can I
 * watch?" mid-game had to be told no.
 *
 * Fetched from `GET /api/links/:token`, which decides what this token is
 * allowed to be told: a player gets its own bound-spectator link, a seatless
 * viewer gets `null` for it. Nothing here decides entitlement.
 */

interface LinksResponse {
  omniscientUrl?: string | null
  publicUrl?: string
  publicLlmUrl?: string | null
  spectatorUrl?: string | null
  llmUrl?: string | null
}

export interface SharePanelProps {
  token: string
  onClose: () => void
}

/** Same-origin rewrite, so a link opened on a phone on the LAN still resolves. */
function localise(url: string): string {
  try {
    const u = new URL(url)
    u.protocol = window.location.protocol
    u.host = window.location.host
    return u.toString()
  } catch {
    return url
  }
}

function Row(props: {
  label: string
  hint: string
  url: string
  tone: 'safe' | 'private' | 'danger'
}) {
  const [copied, setCopied] = useState(false)
  const url = localise(props.url)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // clipboard is unavailable in plenty of contexts; the input below is
      // selectable, so there is always a manual path
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className={`xy-share-row xy-share-${props.tone}`}>
      <div className="xy-share-head">
        <strong>{props.label}</strong>
        <span className={`xy-share-pill xy-share-pill-${props.tone}`}>
          {props.tone === 'safe'
            ? '對局中可安全轉發'
            : props.tone === 'danger'
              ? '雙方全部兵種 — 只給你自己'
              : '含該方全部兵種'}
        </span>
      </div>
      <p className="xy-share-hint">{props.hint}</p>
      <div className="xy-share-url">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => void copy()}>
          {copied ? '已複製' : '複製'}
        </button>
      </div>
    </div>
  )
}

export function SharePanel({ token, onClose }: SharePanelProps) {
  const [links, setLinks] = useState<LinksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/links/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: LinksResponse) => { if (live) setLinks(d) })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [token])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="xy-share-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="xy-share"
        role="dialog"
        aria-modal="true"
        aria-label="分享連結"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="xy-share-top">
          <h2>分享這局</h2>
          <button type="button" onClick={onClose} aria-label="關閉">✕</button>
        </div>

        {error !== null && <p className="xy-share-err">取不到連結：{error}</p>}
        {error === null && links === null && <p className="xy-share-hint">載入中…</p>}

        {links?.publicUrl !== undefined && (
          <Row
            tone="safe"
            label="公開觀戰連結"
            hint="棋盤、公開紀錄、已翻明的兵種與比分。任何一方的隱藏兵種都不會送出，不只是不顯示。給誰都可以。"
            url={links.publicUrl}
          />
        )}

        {links?.publicLlmUrl != null && (
          <Row
            tone="safe"
            label="公開觀戰連結（LLM 純文字版）"
            hint="同一個視角，改成純文字。可以貼給聊天機器人當旁觀者或講評。"
            url={links.publicLlmUrl}
          />
        )}

        {links?.omniscientUrl != null && (
          <Row
            tone="danger"
            label="全知者視角（只有你拿得到）"
            hint="雙方的全部兵種，即時。你身為建立者本來就同時持有兩個座位的連結，所以這條沒有給你任何新東西——但它對任何其他人來說就是整局的答案。給對手等於直接結束遊戲。"
            url={links.omniscientUrl}
          />
        )}

        {links?.spectatorUrl != null && (
          <Row
            tone="private"
            label="綁定觀戰連結（你的視角）"
            hint="與你看到的完全相同——包含你的全部兵種。只給你願意攤牌的人；對局進行中不要給第三者。"
            url={links.spectatorUrl}
          />
        )}
      </div>

      <style>{`
.xy-share-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0,0,0,0.62);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.xy-share {
  background: var(--panel, #14171c);
  border: 1px solid var(--line, rgba(255,255,255,0.12));
  border-radius: 10px; padding: 16px;
  width: min(620px, 100%); max-height: 88vh; overflow-y: auto;
}
.xy-share-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.xy-share-top h2 { margin: 0; font-size: 1.05rem; }
.xy-share-top button {
  background: none; border: none; color: var(--muted, #8b95a5);
  font-size: 1.1rem; cursor: pointer;
}
.xy-share-row {
  margin-top: 14px; padding: 12px;
  border: 1px solid var(--line, rgba(255,255,255,0.12)); border-radius: 8px;
}
.xy-share-safe    { border-color: rgba(80, 200, 130, 0.45); background: rgba(80, 200, 130, 0.06); }
.xy-share-private { border-color: rgba(220, 160, 70, 0.45); background: rgba(220, 160, 70, 0.06); }
.xy-share-danger  { border-color: rgba(225, 90, 90, 0.55);  background: rgba(225, 90, 90, 0.07); }
.xy-share-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.xy-share-pill { font-size: 0.7rem; padding: 2px 7px; border-radius: 99px; white-space: nowrap; }
.xy-share-pill-safe    { background: rgba(80, 200, 130, 0.18); color: #7fe0a8; }
.xy-share-pill-private { background: rgba(220, 160, 70, 0.18); color: #e9bd76; }
.xy-share-pill-danger  { background: rgba(225, 90, 90, 0.20);  color: #f09a9a; }
.xy-share-hint { margin: 6px 0 8px; font-size: 0.8rem; color: var(--muted, #8b95a5); line-height: 1.5; }
.xy-share-err  { color: #e88; font-size: 0.85rem; }
.xy-share-url { display: flex; gap: 6px; }
.xy-share-url input {
  flex: 1; min-width: 0; font-family: ui-monospace, Consolas, monospace; font-size: 0.78rem;
  background: rgba(0,0,0,0.35); color: inherit;
  border: 1px solid var(--line, rgba(255,255,255,0.12)); border-radius: 6px; padding: 6px 8px;
}
.xy-share-url button { white-space: nowrap; }
      `}</style>
    </div>
  )
}
