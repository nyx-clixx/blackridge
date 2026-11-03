FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 && pnpm install --prod --frozen-lockfile
COPY server.js bot.js store.js moderation.js recovery.js ./
COPY public ./public
ENV NODE_ENV=production
CMD ["node","server.js"]

