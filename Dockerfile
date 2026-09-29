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
#     ★ 这里默认 = poc-ai-service：这是 K8s 里后端 Service 的真实名字，
#       已从 devops-cosmos-helm-chart 的
#       cosmos/poc-ai-service/values.yaml `fullnameOverride: "poc-ai-service"`
#       确认。当前 helm chart 的 cosmos/poc-ai-demo/values.yaml 没有注入
#       BACKEND_HOST，所以云上直接吃这个映像默认值——若这里写错（例如 backend，
#       那是 docker-compose 的 service 名，K8s 里不存在），nginx 会报
#       `backend could not be resolved (3: Host not found)`，所有 /api 502。
#     - Docker Compose 本地：由 docker-compose.yml 显式覆盖为 backend（服务名）。
#     - 其他环境如需不同名字：用 env BACKEND_HOST=… 覆盖即可。
#   NGINX_LOCAL_RESOLVERS ：容器 DNS 地址，由入口脚本从 /etc/resolv.conf 自动读取
ENV BACKEND_HOST=poc-ai-service

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
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# 注意：nginx 默认只监听 IPv4（0.0.0.0:80），而容器内 localhost 会优先解析到
# ::1，用 localhost 探测会被 connection refused。这里显式使用 127.0.0.1。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
