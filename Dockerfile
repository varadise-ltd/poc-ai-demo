# =============================================================================
# AI Cam POC Center — 前端镜像（Vue 3 + Vite，多阶段构建）
# =============================================================================
# 构建:  docker build -t poc-ai-demo .
# 运行:  docker run -d -p 8080:80 poc-ai-demo
# 推荐通过 poc-ai-service/docker-compose.yml 启动（nginx 反代 /api/ 到后端）。
#
# 说明：
#   - 构建参数 VITE_API_BASE 默认置空 → 前端使用同源相对路径 /api/...，
#     由 nginx 反向代理到后端容器；如需直连其他后端地址，构建时传入即可：
#       docker build --build-arg VITE_API_BASE=http://10.0.0.5:8000 -t poc-ai-demo .
# =============================================================================

# ---- 构建阶段 ----
FROM node:20-alpine AS build

WORKDIR /app

# 空字符串 = 同源相对路径（api.ts: VITE_API_BASE 已定义则直接使用，未定义时
# 才回退到「页面所在主机的 8000 端口」）
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM nginx:1.27-alpine

# 用 envsubst 模板而非写死的 nginx.conf：后端主机名可在运行时注入。
# 官方 nginx 入口脚本会把 /etc/nginx/templates/*.template 用环境变量替换后
# 生成 /etc/nginx/conf.d/default.conf。
#   BACKEND_HOST          ：后端主机名（nginx 反代 /api/ 的目标）。
#     ★ 必须用「全限定名 FQDN」，不能用短名！
#       nginx 的 resolver 指令「不会」像 glibc 那样按 /etc/resolv.conf 的 search
#       网域自动补全，它会把短名原封不动丢给 CoreDNS，CoreDNS 对裸名回 NXDOMAIN：
#         poc-ai-service could not be resolved (3: Host not found) -> 全部 /api 502
#       因此这里写完整：
#         <Service名>.<namespace>.svc.cluster.local
#       后端 Service 名 = poc-ai-service（fullnameOverride），dev namespace = cosmos，
#       所以 = poc-ai-service.cosmos.svc.cluster.local。
#     - Docker Compose 本地：由 docker-compose.yml 显式覆盖为 backend（Docker 内嵌
#       DNS 会直接解析同网络下的短容器名，无需 FQDN）。
#     - 其他环境（qa/prod 等不同 namespace）：务必用 env BACKEND_HOST 覆盖成该
#       环境的 FQDN（例如 poc-ai-service.cosmos-qa.svc.cluster.local）。
#   NGINX_LOCAL_RESOLVERS ：容器 DNS 地址，由入口脚本从 /etc/resolv.conf 自动读取
ENV BACKEND_HOST=poc-ai-service.cosmos.svc.cluster.local

# 容器 DNS 自动探测（关键）：
#   入口脚本 15-local-resolvers.envsh 会把 /etc/resolv.conf 里的 nameserver
#   导出为 NGINX_LOCAL_RESOLVERS，供 envsubst 写入 resolver 指令。
#   这样同一个镜像在两种环境都能解析后端服务名：
#     - Docker Compose（用户自定义网络）-> 127.0.0.11（Docker 内嵌 DNS）
#     - Kubernetes -> 集群 DNS（如 10.96.0.10 / kube-dns），**不是** 127.0.0.11
#   之前写死 127.0.0.11 在 K8s 上会导致：
#     recv() failed (111: Connection refused) while resolving, resolver: 127.0.0.11:53
#     backend could not be resolved (110: Operation timed out) -> 全部 /api 请求 502
# 若需强制指定 DNS（极少需要），把 NGINX_ENTRYPOINT_LOCAL_RESOLVERS 设为**空值**
# 以关闭自动探测，并自行提供 NGINX_LOCAL_RESOLVERS：
#   -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS= -e NGINX_LOCAL_RESOLVERS=10.96.0.10
# 注意：该入口脚本以「变量非空」作为开关，设成 "0" 并不会关闭它。
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_LOCAL_RESOLVERS=127.0.0.11

# 只允许替换这几个变量；否则 envsubst 会误处理 nginx 自带的变量
# （$host、$scheme、$proxy_add_x_forwarded_for 等），生成的配置会失效。
ENV NGINX_ENVSUBST_FILTER='^(BACKEND_HOST|NGINX_LOCAL_RESOLVERS)$'

# 入口脚本：在 envsubst 渲染模板前归一化 BACKEND_HOST。
# 文件必须放在 /docker-entrypoint.d/ 且以 .envsh 结尾（入口脚本用 source 加载，
# 导出的变量才能传给 20-envsubst-on-templates.sh）；前缀 05 早于 15/20 执行。
# 作用：部署时若把端口写进 BACKEND_HOST（如 poc-ai-service:8000），模板会生成
# "http://poc-ai-service:8000:8000"，nginx 仅**在请求时**报
# "invalid port in upstream" 导致全部 /api 500，且 nginx -t 检测不出。
#
# ★ 重要：docker-entrypoint.d/ 必须提交进 git。
#   Jenkins/Kaniko 用 `--context <workspace>` 从 git checkout 取构建上下文，
#   未提交的文件不在上下文里，COPY 会直接失败：
#     failed to get fileinfo for .../docker-entrypoint.d: no such file or directory
#   （0.1.0-alpha.10 构建失败即此原因）。新增 COPY 源文件后务必 git add 并推送。
COPY docker-entrypoint.d/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.envsh
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# 注意：nginx 默认只监听 IPv4（0.0.0.0:80），而容器内 localhost 会优先解析到
# ::1，用 localhost 探测会被 connection refused。这里显式使用 127.0.0.1。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
