FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@11.25.0 && pnpm install --prod --frozen-lockfile
COPY server.js bot.js store.js analytics.js moderation.js recovery.js domain-feeds.js verification.js appeals.js custom-bot.js messages.js billing.js billing-store.js ./
COPY public ./public
ENV NODE_ENV=production
CMD ["node","server.js"]
