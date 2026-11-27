// iframe token bridge（方案 §3.5）：Cosmos 母站通过 postMessage 把 cmp-webapp access token 交给 POC。
//
// 协议 v1（需与 Cosmos 母站对齐）：
//   POC → 母站：{ type: 'poc:ready', v: 1 }          首次加载，请求 token
//               { type: 'poc:token-request', v: 1 }  续期 / 用户点击登录时再次请求
//   母站 → POC：{ type: 'cosmos:token', v: 1, token }（也兼容字段名 accessToken）
//               母站刷新 token 后可随时主动推送，无需等待请求。
//
// 安全：只接受 event.source === window.parent 且 origin 在白名单（COSMOS_PARENT_ORIGIN）内的消息；
// 发送时逐个指定白名单 origin（绝不用 '*'），浏览器会丢弃 origin 不匹配的投递。
// token 只交给回调（立即换同源会话），本模块不存储、不打印 token。

export type BridgeRequest = 'poc:ready' | 'poc:token-request'
type TokenListener = (token: string) => void

let allowedOrigins: string[] = []
let installed = false
let listeners: TokenListener[] = []

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return
  if (!allowedOrigins.includes(event.origin)) {
    console.warn('[auth] ignored postMessage from non-allowed origin', { origin: event.origin })
    return
  }
  const data = event.data as { type?: unknown; token?: unknown; accessToken?: unknown } | null
  if (!data || data.type !== 'cosmos:token') return
  const token = typeof data.token === 'string' ? data.token : typeof data.accessToken === 'string' ? data.accessToken : ''
  if (!token) return
  console.info('[auth] received Cosmos token from parent origin=%s', event.origin)
  for (const listener of [...listeners]) listener(token)
}

/** 安装 message 监听（幂等）。 */
export function installBridge(origins: string[]): void {
  allowedOrigins = origins
  if (installed) return
  installed = true
  window.addEventListener('message', onMessage)
}

/** 订阅母站下发的 token，返回取消订阅函数。 */
export function onParentToken(listener: TokenListener): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

/** 向母站请求 token：逐个白名单 origin 投递（不匹配的由浏览器丢弃）。 */
export function requestParentToken(type: BridgeRequest): void {
  if (!allowedOrigins.length) {
    console.warn('[auth] COSMOS_PARENT_ORIGIN is empty: cannot request a token from the Cosmos parent')
    return
  }
  for (const origin of allowedOrigins) {
    try {
      window.parent.postMessage({ type, v: 1 }, origin)
    } catch (e) {
      console.warn('[auth] postMessage to parent failed', { origin, e })
    }
  }
}

/** 请求并等待母站下发 token；超时返回 null。 */
export function waitForParentToken(timeoutMs: number, type: BridgeRequest): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = onParentToken((token) => {
      clearTimeout(timer)
      off()
      resolve(token)
    })
    timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeoutMs)
    requestParentToken(type)
  })
}

/** 测试用：重置模块状态。 */
export function _resetBridgeForTest(): void {
  if (installed && typeof window !== 'undefined' && window.removeEventListener) {
    window.removeEventListener('message', onMessage)
  }
  allowedOrigins = []
  installed = false
  listeners = []
}
