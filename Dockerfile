# syntax=docker/dockerfile:1

########## 构建阶段：安装依赖、编译前后端、预下载 CloakBrowser Chromium ##########
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

# 先拷贝依赖清单，最大化利用 Docker 构建缓存
COPY package.json pnpm-lock.yaml ./
COPY backend-ts/package.json backend-ts/pnpm-lock.yaml ./backend-ts/
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN pnpm --dir backend-ts install --frozen-lockfile --ignore-scripts \
 && pnpm --dir frontend install --frozen-lockfile --ignore-scripts

# 拷贝源码并构建（前端产物输出到 static/，后端编译到 backend-ts/dist/）
COPY . .
RUN pnpm --dir frontend build && pnpm --dir backend-ts build

# 预下载 CloakBrowser 隐身 Chromium（免费版，无需 license key），
# 缓存到固定目录，运行阶段整体拷贝，避免容器首启时联网下载。
ENV CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser
RUN pnpm --dir backend-ts exec cloakbrowser install

########## 运行阶段：仅包含生产依赖与运行所需文件 ##########
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CLOAKBROWSER_CACHE_DIR=/app/.cloakbrowser

# Chromium 无头运行所需的系统依赖（含中文字体，避免网页乱码影响风控判断）
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 libglib2.0-0 \
      fonts-liberation fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

# 仅安装后端生产依赖
COPY backend-ts/package.json backend-ts/pnpm-lock.yaml ./backend-ts/
RUN pnpm --dir backend-ts install --prod --frozen-lockfile --ignore-scripts

# 应用文件：后端编译产物、启动器、前端静态资源、模型默认参数
COPY backend-ts/start.mjs ./backend-ts/
COPY --from=build /app/backend-ts/dist ./backend-ts/dist
COPY --from=build /app/static ./static
COPY config.yaml ./

# CloakBrowser Chromium 缓存与运行数据目录（账号、Cookie、统计等）
COPY --from=build --chown=app:app /app/.cloakbrowser ./.cloakbrowser

# 以非 root 用户运行（Chromium 沙箱要求；同时降低容器内风险）
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /app/data \
 && chown -R app:app /app
USER app

# 数据持久化目录：账号、Cookie、API 密钥、统计、.env
VOLUME ["/app/data"]

EXPOSE 3006

# 跳过启动时编译（镜像内已完成构建），直接启动服务
CMD ["node", "backend-ts/start.mjs", "--skip-build"]
