# Version (Commit) aus dem .git-Verzeichnis ablesen – ohne git im Image
FROM node:22-alpine AS version
WORKDIR /src
COPY . .
RUN node -e "import('./lib/version.js').then((m) => process.stdout.write(JSON.stringify(m.readGitVersion('.'))))" > /version.json

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY --from=version /version.json ./version.json
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
