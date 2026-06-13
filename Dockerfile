# 01-mm-pro — production market maker
# Runs via tsx (same path as `npm run bot`) so the toHex/fromHex polyfill is
# loaded identically to local dev. No separate build step / dist drift.

FROM node:22-slim

# tini = proper PID 1 so SIGINT/SIGTERM reach the bot for graceful shutdown
# (cancels resting orders before exit).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching).
COPY package*.json ./
RUN npm ci

# App source.
COPY tsconfig.json biome.json ./
COPY src ./src

# Typecheck at build time — fail the image if the code doesn't compile.
RUN npm run typecheck

# Drop root.
USER node

# tini -> npm script keeps the polyfill + tsx loader chain intact.
ENTRYPOINT ["tini", "--"]
CMD ["npm", "run", "bot"]
