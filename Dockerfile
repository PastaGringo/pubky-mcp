FROM mirror.gcr.io/library/node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --prod
COPY src ./src
ENV NODE_ENV=production PORT=4100 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 4100
USER node
CMD ["node", "src/server.ts"]
