FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4173
ENV DATABASE_PATH=/data/goodroot.sqlite
ENV UPLOADS_DIRECTORY=/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/uploads && chown -R node:node /app /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/migrations ./src/migrations
COPY --chown=node:node public ./public
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--env-file-if-exists=.env", "dist/src/server.js"]
