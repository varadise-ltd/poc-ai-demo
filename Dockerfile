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
#   BACKEND_HOST   ：后端主机名（默认 backend，即 compose 服务名）
#   NGINX_RESOLVER ：容器 DNS（默认 127.0.0.11 = Docker 内嵌 DNS；K8s 设为
#                    kube-dns 地址），用于「请求时解析」后端地址
# 云上单独 run 前端容器时用 -e BACKEND_HOST=<后端域名> 覆盖。
ENV BACKEND_HOST=backend \
    NGINX_RESOLVER=127.0.0.11
# 只允许替换这两个变量；否则 envsubst 会误处理 nginx 自带的变量
# （$host、$scheme、$proxy_add_x_forwarded_for 等），生成的配置会失效。
ENV NGINX_ENVSUBST_FILTER='^(BACKEND_HOST|NGINX_RESOLVER)$'
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# 注意：nginx 默认只监听 IPv4（0.0.0.0:80），而容器内 localhost 会优先解析到
# ::1，用 localhost 探测会被 connection refused。这里显式使用 127.0.0.1。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
