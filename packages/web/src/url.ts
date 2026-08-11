/**
 * Token plumbing. Tokens are the only auth (techspec §5) and arrive in the URL
 * the server handed out. The server owns the URL shape, so the parser below is
 * deliberately tolerant: query, hash, or a path segment all work.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{8,}$/
const TOKEN_PATH_PREFIXES = new Set(['g', 'game', 'play', 'join', 's', 'spectate', 'watch'])

export function parseToken(loc: { pathname: string; search: string; hash: string }): string | null {
  const query = new URLSearchParams(loc.search)
  for (const key of ['token', 't']) {
    const v = query.get(key)
    if (v && TOKEN_RE.test(v)) return v
  }

  const hash = loc.hash.replace(/^#\/?/, '')
  if (hash) {
    const last = hash.split('/').filter(Boolean).pop()
    if (last && TOKEN_RE.test(last)) return last
  }

  const segments = loc.pathname.split('/').filter(Boolean)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const next = segments[i + 1]
    if (TOKEN_PATH_PREFIXES.has(seg.toLowerCase()) && TOKEN_RE.test(next)) return next
  }
  if (segments.length === 1 && TOKEN_RE.test(segments[0])) return segments[0]

  return null
}

/**
 * Rewrites a server-issued absolute URL onto the origin this page is served
 * from. In dev the client runs on Vite's port while the server advertises its
 * own PUBLIC_BASE_URL, so the raw link would jump to the wrong port; the share
 * link shown to the user is always the server's own, this is only for the
 * "open here" convenience link.
 */
export function localizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    return `${window.location.origin}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}
