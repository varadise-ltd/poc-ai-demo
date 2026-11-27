# Keycloak 配置待办清单（给管理员）

> 适用 realm：`cmp-dev`（`https://cosmos-dev.varadise.cloud/auth/realms/cmp-dev`）
> 目的：让 `poc-ai-demo`（纯静态前端 nginx）与 `poc-ai-service`（后端统一承载 `/auth/*` 登录会话与 `/api/*` 鉴权，无独立 BFF 进程/镜像）能够通过 Cosmos 账号登录。
> 以下所有改动都在 Keycloak 管理控制台完成，不涉及代码仓库。

---

## 一、必须项（缺一不可，否则登录无法完成）

### 1. `poc-ai-demo` 客户端（浏览器登录用）

| 项 | 值 / 操作 |
|---|---|
| Client ID | `poc-ai-demo` |
| Client Protocol | `openid-connect` |
| Access Type | `confidential`（需要 client secret） |
| **Standard Flow Enabled** | ✅ 开启（Authorization Code + PKCE） |
| **Direct Access Grants Enabled** | 建议 ❌ 关闭。后端默认关闭账号密码直登（`COSMOS_SSO_PASSWORD_LOGIN` 未设置）；standalone 未登录会**自动跳转** Cosmos 登录页。只有在 Redirect URIs 补齐之前的过渡期，才同时开启本项并在后端设 `COSMOS_SSO_PASSWORD_LOGIN=1` |
| **Valid Redirect URIs** | `http://localhost:5173/auth/callback`、`http://127.0.0.1:5173/auth/callback`、`https://poc-aicctv-dev.varadise.cloud/auth/callback`（**当前在 Keycloak 中为空，跳转登录报「无效的参数：redirect_uri」即因未配置此项**） |
| **Valid Post Logout Redirect URIs** | `http://localhost:5173/*`、`http://127.0.0.1:5173/*`、`https://poc-aicctv-dev.varadise.cloud/*` |
| **Web Origins** | `http://localhost:5173`、`http://127.0.0.1:5173`、`https://poc-aicctv-dev.varadise.cloud` |
| **Backchannel Logout URL** | `https://poc-aicctv-dev.varadise.cloud/auth/backchannel-logout`（开启 `Backchannel Logout Session Required`），Cosmos 登出时同步清除 POC 会话 |
| **Audience Mapper** | Client Scopes → `poc-ai-demo-dedicated` → Add mapper → `Audience`：`Included Custom Audience = poc-ai-service`，开启 `Add to access token` |

> ⚠️ standalone 现在会自动跳转 Keycloak 登录页：**Valid Redirect URIs 未配置时，用户会停在 Keycloak 的「无效的参数：redirect_uri」错误页**。上线前必须先补齐 Redirect URIs。
>
> ⚠️ 实测状态：`poc-ai-demo` 的 Direct Access Grants 已开启（本地页面输账号密码直登可用）；但 **Valid Redirect URIs 尚未配置**（本地与云 dev 回调地址都会被 Keycloak 拒绝报 `无效的参数：redirect_uri`），需管理员补齐上表 Redirect URIs 与 Audience Mapper。

### 2. 客户端角色（授权矩阵用，按需创建）

在 `poc-ai-demo` 客户端下创建两个 client role：

| Client Role | 用途 |
|---|---|
| `poc-platform-admin` | 平台管理员（对应后端 `POC_PLATFORM_ADMIN_ROLE`） |
| `poc-varadise-user` | Varadise 账号级授权（对应 `VARADISE_GRANT_CLIENT_ROLE`） |

### 3. Realm 角色（登录门槛用，确认已存在）

| Realm Role | 说明 |
|---|---|
| `Cosmos User` | 普通成员（后端 `COSMOS_ALLOWED_ROLES` 默认含此角色） |
| `cosmos-admin` | 管理员 |

> 登录后校验：用户必须拥有 `Cosmos User` 或 `cosmos-admin` 之一，否则返回 `access_denied`（403）。

### 4. `poc-ai-service` 客户端（后端 M2M / Service Account 用）

| 项 | 值 / 操作 |
|---|---|
| Client ID | `poc-ai-service` |
| Client Protocol | `openid-connect` |
| Access Type | `confidential` |
| **Service Accounts Enabled** | ✅ 开启 |
| **Client Secret** | 已确认有效（后端启动日志 `service token refreshed: client_id=poc-ai-service` 成功） |

### 5. `poc-ai-service` 客户端 scope `poc-varadise-grants`（Varadise 授权名单）

| 项 | 值 / 操作 |
|---|---|
| 新建 Client Scope | 名称 `poc-varadise-grants`，类型 `Optional` |
| 添加 Mapper | `Hardcoded claim`，Claim Name = `poc_varadise_orgs`，JSON 值 = Varadise 组织 UUID 列表（数组） |
| 关联到客户端 | 把 `poc-varadise-grants` scope 分配到 `poc-ai-service` 客户端（含在 service account token 的 scope 里） |

> ⚠️ 当前后端日志报错：`claim 'poc_varadise_orgs' missing from service token`。不配好这个 scope，登录成功后 Varadise 授权名单为空，用户仍会看到「No organization available」页面。

---

## 二、非阻塞但强烈建议（影响登录后的数据可见性）

### 6. profile-service 地址与内部 API Key（后端侧，非 Keycloak）

| 配置项 | 说明 |
|---|---|
| `PROFILE_SERVICE_URL` | 成员关系查询地址，如 `http://profile-service:8082`（集群内）或可达的外网地址 |
| `INTERNAL_API_KEY` | 调 profile-service 的共享 X-API-Key |

> ⚠️ 当前后端日志报错：`profile-service org sync (startup) failed: INTERNAL_API_KEY or PROFILE_SERVICE_URL is not configured`。不配好会导致：登录后拿不到用户所属组织列表（成员关系校验不可用）。

---

## 三、验收标准（管理员配完后，开发者按此自测）

| 场景 | 预期 |
|---|---|
| 浏览器打开 `http://127.0.0.1:5173/` | 显示独立登录页（账号密码表单 + 「跳转 Cosmos 登录」按钮） |
| 表单输入正确 Cosmos 账号密码 | 登录成功，进入前端系统 |
| 表单输入错误密码 | 显示「Invalid username or password」 |
| 点击「Continue on the Cosmos sign-in page」 | 302 跳转到 Keycloak 登录页，登录后回跳 POC |
| 用户无 `Cosmos User/admin` 角色 | 拒绝登录（`access_denied`） |
| 登录成功后能进入系统且看到所属组织 | 需要第 5、6 项已配好 |

---

## 四、服务端环境变量（全部集中在 `poc-ai-service`，前端零密钥）

```dotenv
# poc-ai-service/.env.local（本机或 K8s Secret/ConfigMap；poc-ai-demo 无需任何 OIDC/BFF 变量）
AUTH_MODE=optional
COSMOS_OIDC_ISSUER=https://cosmos-dev.varadise.cloud/auth/realms/cmp-dev
COSMOS_SSO_CLIENT_ID=poc-ai-demo
COSMOS_SSO_CLIENT_SECRET=<poc-ai-demo 的 secret>
COSMOS_SSO_PUBLIC_ORIGIN=https://poc-aicctv-dev.varadise.cloud   # 本机开发自动兼容 http://localhost:5173
KEYCLOAK_CLIENT_ID=poc-ai-service
KEYCLOAK_CLIENT_SECRET=<poc-ai-service 的 secret>
```

> 生产环境：`APP_ENV=prod`、`AUTH_MODE=required`、`COSMOS_SSO_PUBLIC_ORIGIN` 必须为 `https://`（自动使用 `__Host-poc_sid` Secure Cookie），所有 Secret 只放 K8s Secret。


---

## 附：两个场景的部署检查清单（非 Keycloak 项，由部署/平台负责）

| # | 项 | 说明 |
|---|---|---|
| 1 | 前端用 nginx 镜像 | 页面、`/api/*`、`/auth/*` 必须同源。用 `Dockerfile` / `docker-compose.cloud.yml`，或 `deploy/cloud-nginx-api-gateway.conf.template`（已含 `/auth/`，且不再注入共享 Token）。`docker-compose.yml`（`Dockerfile.standalone`）不支持 SSO |
| 2 | `COSMOS_PARENT_ORIGIN` | DEV 设 `https://cosmos-dev.varadise.cloud`；镜像默认同时允许 PROD 与 DEV 母站 |
| 3 | Ingress / WAF | 移除 `X-Frame-Options: sameorigin`，否则 iframe 仍被拒（CSP `frame-ancestors` 已由前端 nginx 下发） |
| 4 | Cosmos iframe | 若使用 `sandbox`，需包含 `allow-scripts allow-same-origin allow-forms allow-popups`（静默登录失败时的弹窗登录需要 `allow-popups`） |
| 5 | 后端 `AUTH_MODE` | 灰度可用 `optional`：浏览器 SSO 启用后匿名 `/api` 请求已被拒（`AUTH_ALLOW_ANONYMOUS=1` 才放行）。正式环境用 `required` + `PERMISSION_MODE=enforce` |
| 6 | `COSMOS_SSO_CLIENT_SECRET` | 必填。配了 `COSMOS_SSO_PUBLIC_ORIGIN` 却没填 secret：dev 记 ERROR 日志，qa/staging/prod 拒绝启动 |
| 7 | `COSMOS_SSO_SESSION_ENC_KEY` | 必填固定 32 字节密钥（`openssl rand -hex 32`），放 Secret。qa/staging/prod 未配置拒绝启动 |
| 8 | 会话存储 | 配了固定密钥且有 PostgreSQL 时自动存库（`COSMOS_SSO_SESSION_STORE=auto`），重启/多副本不掉登录；否则为进程内存，只能单副本 |
