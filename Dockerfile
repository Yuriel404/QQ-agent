ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base
FROM base AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    --registry=https://registry.npmjs.org --replace-registry-host=always

FROM base
WORKDIR /app
ENV NODE_ENV=production \
    QQ_AGENT_HOST=0.0.0.0 \
    QQ_AGENT_PORT=3210 \
    QQ_AGENT_DATA_DIR=/var/lib/qq-agent/data

# slim 镜像可能尚无系统 CA，先用 Node 自带的根证书验证 Debian HTTPS 源。
RUN node -p "require('node:tls').rootCertificates.join('\n')" > /tmp/apt-ca.pem \
    && sed -i 's|http://deb.debian.org/|https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/apt-ca.pem -o Acquire::Retries=3 update \
    && apt-get -o Acquire::https::CaInfo=/tmp/apt-ca.pem -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/* /tmp/apt-ca.pem \
    && install -d -m 0700 -o node -g node /var/lib/qq-agent \
    && mkdir -p /app/skills /app/plugins

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src/ ./src/
COPY ui/ ./ui/

USER node
EXPOSE 3210
CMD ["node", "src/server.js"]
