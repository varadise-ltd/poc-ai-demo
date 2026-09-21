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

# 空字符串 = 同源相对路径（api.ts: import.meta.env.VITE_API_BASE ?? 'http://localhost:8000'）
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
