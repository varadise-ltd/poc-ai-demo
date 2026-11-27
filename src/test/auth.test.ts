// Cosmos SSO BFF 薄壳（方案 v1.3 §5.3 / §5.6 / §5.7）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as authMod from '../auth'

type Store = Record<string, string>

function stubWindow(opts: { href?: string; iframe?: boolean } = {}) {
  const href = opts.href ?? 'https://poc.test/?orgId=11111111-1111-4111-8111-111111111111'
  const session: Store = {}
  const assign = vi.fn()
  const reload = vi.fn()
  const replaceState = vi.fn()
  const self = {}
  const win: Record<string, unknown> = {
    location: { href, origin: 'https://poc.test', search: new URL(href).search, assign, reload },
    history: { replaceState },
    sessionStorage: {
      getItem: (k: string) => session[k] ?? null,
      setItem: (k: string, v: string) => { session[k] = v },
      removeItem: (k: string) => { delete session[k] },
    },
    open: vi.fn(() => null),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  win.self = self
  win.top = opts.iframe ? {} : self
  vi.stubGlobal('window', win)
  return { assign, reload, replaceState, session, win }
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => authMod._resetAuthForTest())
afterEach(() => vi.unstubAllGlobals())

describe('initAuth', () => {
  it('BFF not deployed (404 / html) → SSO disabled, app usable', async () => {
    stubWindow()
    stubFetch(() => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    await authMod.initAuth()
    expect(authMod.auth.enabled).toBe(false)
    expect(authMod.auth.authenticated).toBe(true)
  })

  it('valid session → authenticated, user loaded, no token in browser', async () => {
    stubWindow()
    stubFetch(() => json(200, { authenticated: true, sub: 'alice', name: 'Alice', email: 'a@x', roles: ['Cosmos User'] }))
    await authMod.initAuth()
    expect(authMod.auth.enabled).toBe(true)
    expect(authMod.auth.authenticated).toBe(true)
    expect(authMod.auth.user?.name).toBe('Alice')
  })

  it('standalone without session → redirects to the Cosmos sign-in page automatically', async () => {
    const w = stubWindow({ href: 'https://poc.test/live?x=1' })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(authMod.auth.enabled).toBe(true)
    expect(authMod.auth.authenticated).toBe(false)
    expect(w.assign).toHaveBeenCalledWith(`/auth/login?return_to=${encodeURIComponent('/live?x=1')}`)
  })

  it('standalone: after 2 automatic redirects within 2 minutes, stay on LoginView', async () => {
    const w = stubWindow({ href: 'https://poc.test/live?x=1' })
    w.session['cosmos.auth.silentAttempts'] = JSON.stringify([Date.now(), Date.now()])
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(w.assign).not.toHaveBeenCalled()
    authMod.login()
    expect(w.assign).toHaveBeenCalledWith(`/auth/login?return_to=${encodeURIComponent('/live?x=1')}`)
  })

  it('password login flag comes from the backend (off by default)', async () => {
    stubWindow({ href: 'https://poc.test/?sso_error=login_required' })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(authMod.auth.passwordLogin).toBe(false)
    authMod._resetAuthForTest()
    stubWindow({ href: 'https://poc.test/?sso_error=login_required' })
    stubFetch(() => json(401, { authenticated: false, password_login: true }))
    await authMod.initAuth()
    expect(authMod.auth.passwordLogin).toBe(true)
  })

  it('iframe without session → silent prompt=none first, never navigates the top window', async () => {
    const w = stubWindow({ iframe: true })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(w.assign).toHaveBeenCalledTimes(1)
    expect(String(w.assign.mock.calls[0][0])).toContain('/auth/login?prompt=none&return_to=')
  })

  it('iframe: after 2 silent attempts within 2 minutes, show the button instead of looping', async () => {
    const w = stubWindow({ iframe: true })
    w.session['cosmos.auth.silentAttempts'] = JSON.stringify([Date.now(), Date.now()])
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(w.assign).not.toHaveBeenCalled()
    expect(authMod.auth.authenticated).toBe(false)
  })

  it('sso_error=login_required from the silent attempt → no redirect, login page shown', async () => {
    const w = stubWindow({ iframe: true, href: 'https://poc.test/?sso_error=login_required' })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(w.assign).not.toHaveBeenCalled()
    expect(w.replaceState).toHaveBeenCalled()
  })

  it('sso_error=access_denied → denied status', async () => {
    stubWindow({ href: 'https://poc.test/?sso_error=access_denied' })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    expect(authMod.auth.status).toBe('denied')
  })

  it('denied user can return to Cosmos sign-in and preserve the POC route', async () => {
    const w = stubWindow({ href: 'https://poc.test/live?camera=abc&sso_error=access_denied' })
    stubFetch(() => json(401, { authenticated: false }))
    await authMod.initAuth()
    authMod.login()
    expect(w.assign).toHaveBeenCalledWith(`/auth/login?return_to=${encodeURIComponent('/live?camera=abc')}`)
  })
})

describe('login / logout', () => {
  it('iframe button opens a popup (user gesture), blocked popup shows a hint', async () => {
    const w = stubWindow({ iframe: true })
    stubFetch(() => json(401, {}))
    authMod.auth.inIframe = true
    authMod.login()
    expect(w.win.open).toHaveBeenCalledWith('/auth/login?mode=popup&return_to=%2F', 'cosmos-sso', expect.any(String))
    expect(authMod.auth.message).toContain('Pop-up blocked')
  })

  it('standalone logout ends the Keycloak session (redirect) and sends CSRF header', async () => {
    const w = stubWindow()
    const f = stubFetch(() => json(200, { redirect: 'https://kc.test/logout?x' }))
    await authMod.logout()
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/auth/logout')
    expect((init?.headers as Record<string, string>)['X-POC-CSRF']).toBe('1')
    expect(init?.method).toBe('POST')
    expect(w.assign).toHaveBeenCalledWith('https://kc.test/logout?x')
  })

  it('iframe logout is local only (does not log the Cosmos parent out)', async () => {
    const w = stubWindow({ iframe: true })
    const f = stubFetch(() => json(200, { redirect: null }))
    authMod.auth.inIframe = true
    await authMod.logout()
    expect(f.mock.calls[0][0]).toBe('/auth/logout?local=1')
    expect(w.reload).toHaveBeenCalled()
  })

  it('handleUnauthorized marks session expired once when SSO is enabled (iframe triggers silent login)', () => {
    const w = stubWindow({ iframe: true })
    authMod.auth.enabled = true
    authMod.auth.authenticated = true
    authMod.auth.inIframe = true
    authMod.handleUnauthorized()
    authMod.handleUnauthorized()
    expect(w.assign).toHaveBeenCalledTimes(1)
    expect(authMod.auth.status).toBe('expired')
  })

  it('handleUnauthorized does nothing while the login page is shown', () => {
    const w = stubWindow()
    authMod.auth.enabled = true
    authMod.auth.authenticated = false
    authMod.handleUnauthorized()
    expect(w.assign).not.toHaveBeenCalled()
  })

  it('handleUnauthorized with SSO disabled flags a deployment problem instead of looping', () => {
    const w = stubWindow()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    authMod.handleUnauthorized()
    expect(w.assign).not.toHaveBeenCalled()
    expect(authMod.auth.misconfigured).toBe(true)
  })
})
