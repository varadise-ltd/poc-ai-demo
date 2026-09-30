# 移除平台層 `X-Frame-Options: sameorigin` 操作手冊

> 目標：讓母站 `https://cosmos.varadise.cloud` 以 `<iframe>` 正常嵌入子站
> `https://poc-aicctv-dev.varadise.cloud`（AI Cam POC Center）。
>
> 本文件可**單獨執行**：照「第 1 → 2 → 3 → 4 節」順序操作即可，不依賴其他文件。

---

## 0. 背景

子站前端是 Vue SPA。它本身（`poc-ai-demo` 映像內 `nginx.conf.template`）**已經**正確發出：

```http
Content-Security-Policy: frame-ancestors https://cosmos.varadise.cloud
```

但從公網存取時，回應被**平台層**（Ingress / WAF / 邊緣閘道）額外加上：

```http
X-Frame-Options: sameorigin
```

瀏覽器**同時看到兩者時，會採納更嚴格的 `X-Frame-Options`**，因此跨來源的 iframe 仍被拒絕，Console 報：

```text
Refused to display 'https://poc-aicctv-dev.varadise.cloud/' in a frame
because it set 'X-Frame-Options' to 'sameorigin'.
```

**要修的是平台層，不是應用程式 repo**（該 repo 不含此標頭）。

---

## 1. 前置條件

| 需求 | 說明 |
|---|---|
| `kubectl` | 已設定，能存取部署該前端所在的叢集 |
| 命名空間 | 本文以 `cosmos` 為例，請換成實際值 |
| Deployment 名稱 | 本文以 `poc-ai-demo` 為例 |
| 平台控制台權限 | 若標頭來自 WAF/邊緣閘道，需有該服務的設定權限 |
| `curl` | 本機驗證用 |

先用環境變數固定參數，之後直接複製貼上：

```bash
export NS=cosmos
export DEPLOY=poc-ai-demo
export HOST=poc-aicctv-dev.varadise.cloud
export PARENT=https://cosmos.varadise.cloud
```

---

## 2. 第一步：確認現狀

### 2.1 從公網看最終回應標頭

```bash
curl -sSI "https://${HOST}/" | grep -iE 'x-frame-options|content-security-policy'
```

**判讀：**

- 有 `X-Frame-Options: sameorigin` → 還沒修好，繼續。
- 只有 `Content-Security-Policy: frame-ancestors ...` → 已修好。
- 兩者都沒有 → 前面某層把標頭剝掉了，也需確認。

### 2.2 記錄「現在是誰加的」

```bash
curl -sSI "https://${HOST}/" | grep -iE '^(server|via|x-powered|cf-|x-amz)'
```

記下 `Server` / `Via` 識別字，能幫你判斷是華為雲 WAF、ingress-nginx 還是其他閘道。

---

## 3. 第二步：定位 `X-Frame-Options` 來源

標頭可能在三個地方之一，**從內往外**逐一排查。

### 3.1 應用層（pod 內 nginx）—— 先排除它

進入 pod 直接看「不經 Ingress/WAF」的回應：

```bash
kubectl exec -n "$NS" "deploy/$DEPLOY" -- curl -sSI http://localhost/ \
  | grep -iE 'x-frame-options|content-security-policy'
```

**判讀：**

- 若 pod 內**沒有** `X-Frame-Options`（只有 `frame-ancestors`）→ 應用層乾淨，標頭來自外部，跳 3.2。
- 若 pod 內**有** `X-Frame-Options` → 標頭在映像裡，需改 `nginx.conf.template`（本 repo 已無此標頭，正常不會發生）。

### 3.2 ingress-nginx（K8s Ingress）

#### (a) 找出這個 host 對應的 Ingress

```bash
kubectl get ingress -n "$NS" -o wide
```

找到 `HOST` 欄含 `poc-aicctv-dev.varadise.cloud` 的那筆，記下 Ingress 名稱。

#### (b) 檢查 Ingress 是否加了該標頭

```bash
kubectl get ingress -n "$NS" <INGRESS_NAME> -o yaml \
  | grep -iE 'x-frame-options|frame-ancestors|configuration-snippet|server-snippet|add-headers'
```

若命中 `X-Frame-Options`，來源就是這個 Ingress 的 annotation。

#### (c) 檢查 ingress-nginx 全域 ConfigMap

```bash
kubectl get cm -n ingress-nginx ingress-nginx-controller -o yaml \
  | grep -iE 'x-frame-options|http-snippet|server-snippet|proxy-set-headers'
```

（命名空間可能是 `ingress-nginx` 或 `kube-system`，依部署而定：

```bash
kubectl get cm -A | grep -iE 'ingress-nginx-controller|ingress.*config'
```

若全域 ConfigMap 命中，代表**所有**經該 Ingress 的 host 都被加了標頭。）

### 3.3 邊緣閘道 / WAF（華為雲）

若 3.1、3.2 都乾淨，標頭來自 K8s 之外的邊緣層（例如華為雲 WAF / ELB 安全策略）。

在華為雲控制台找對應入口：

- **WAF（Web 應用防火牆）** → 防護網站清單 → 找到該網域 → 防護策略 → 網頁防篡改 / 自訂回應標頭
- **ELB / CDN** → 高級配置 → 自訂 HTTP 回應標頭

常見樣式是在「自訂回應標頭」加了：

```text
X-Frame-Options: sameorigin
```

---

## 4. 第三步：依來源移除

### 4.1 來源是 Ingress annotation

`kubectl edit ingress -n "$NS" <INGRESS_NAME>`，在 `metadata.annotations` 移除那段加 `X-Frame-Options` 的 snippet（例如 `configuration-snippet` 或 `server-snippet`）。

改為**只保留允許母站的 CSP**：

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/server-snippet: |
      more_clear_headers "X-Frame-Options";
      add_header Content-Security-Policy "frame-ancestors ${PARENT}" always;
```

> `more_clear_headers` 依賴 ingress-nginx 內建的 headers-more 模組（預設啟用）。
> 若平台停用 `server-snippet`，改用 `configuration-snippet`，兩者皆停用則走 4.2。

### 4.2 來源是 ingress-nginx 全域 ConfigMap

```bash
kubectl edit cm -n ingress-nginx ingress-nginx-controller
```

移除 `http-snippet` / `server-snippet` 內加 `X-Frame-Options` 的指令。

若全域加標頭是出於「對所有服務統一加安全標頭」，建議改成**只對需要防護的服務加**，不要對這個前端加。可在 ConfigMap 用 `proxy-hide-header` 由個別 Ingress 覆寫，或把該前端移出全域規則。

### 4.3 來源是華為雲 WAF / ELB

在控制台找到該網域的「自訂回應標頭」設定，**刪除**：

```text
X-Frame-Options: sameorigin
```

（若需要，可改加 CSP `frame-ancestors`，但應用層已加，通常直接刪除即可，避免重複標頭。）

### 4.4 套用後確認生效

```bash
# ingress 變更通常即時生效；若無效，重載控制器
kubectl rollout restart -n ingress-nginx deployment/ingress-nginx-controller
```

---

## 5. 第四步：驗證

### 5.1 標頭檢查

```bash
curl -sSI "https://${HOST}/" | grep -iE 'x-frame-options|content-security-policy'
```

**期望輸出（缺一不可）：**

```http
content-security-policy: frame-ancestors https://cosmos.varadise.cloud
```

**且不得再出現：**

```http
x-frame-options: sameorigin
```

### 5.2 母站 CSP 檢查（不需改，僅確認）

```bash
curl -sSI "https://cosmos.varadise.cloud/" | grep -i 'content-security-policy'
```

母站 `frame-src` 已含 `*`，會放行任何來源的 iframe，無需更動。

### 5.3 瀏覽器實測

1. 開啟 `https://cosmos.varadise.cloud/` 的頁面
2. 加入 `<iframe src="https://poc-aicctv-dev.varadise.cloud/" style="width:100%;height:100vh;border:0"></iframe>`
3. DevTools → Console 確認**不再**出現 `Refused to display ... in a frame`

---

## 6. 回滾

任一方案都是「刪除一行設定」，回滾就是把刪掉的那行加回去：

- Ingress：還原 `X-Frame-Options: sameorigin` 到 annotation
- ConfigMap：還原 `http-snippet` / `server-snippet`
- WAF：還原自訂回應標頭

然後：

```bash
curl -sSI "https://${HOST}/" | grep -i 'x-frame-options'
# 應重新看到 x-frame-options: sameorigin
```

---

## 7. 附錄：重複 CSP header 的處理

若驗證時看到**兩次** `content-security-policy: frame-ancestors ...`，代表應用層與平台層各加了一次。功能上兩條相同（瀏覽器取交集，仍允許母站），但建議**只保留一層**以免誤導：

- 傾向保留**平台層**（可全域統一管理），則從 `nginx.conf.template` 移除該 `add_header`；
- 或保留**應用層**，則平台層只 `more_clear_headers "X-Frame-Options";` 不再另加 CSP。

---

## 8. 快速命令速查

```bash
export NS=cosmos DEPLOY=poc-ai-demo HOST=poc-aicctv-dev.varadise.cloud PARENT=https://cosmos.varadise.cloud

# 現狀
curl -sSI "https://${HOST}/" | grep -iE 'x-frame-options|content-security-policy'

# 排除應用層
kubectl exec -n "$NS" "deploy/$DEPLOY" -- curl -sSI http://localhost/ | grep -iE 'x-frame-options|content-security-policy'

# 找 Ingress
kubectl get ingress -n "$NS" -o wide

# 找全域 ConfigMap
kubectl get cm -A | grep -iE 'ingress-nginx-controller|ingress.*config'
```
