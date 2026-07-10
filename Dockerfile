# ─────────────────────────────────────────────────────────────────────────────
# RAXIS Backend Dockerfile for Render deployment
# Uses official Puppeteer image which comes with Chromium + all required libs
# ─────────────────────────────────────────────────────────────────────────────

FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Puppeteer image runs as non-root user 'pptruser' — need to use its home dir
WORKDIR /home/pptruser/app

# Copy package files first (Docker layer caching)
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies; skip Puppeteer's Chromium download (image already has it)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
RUN npm install

# Copy source code
COPY --chown=pptruser:pptruser . .

# Build TypeScript
RUN npm run build

# Copy prompts folder into dist so runtime can find them
RUN cp -r src/prompts dist/prompts

# Render sets PORT dynamically; the app must listen on it
ENV PORT=10000
EXPOSE 10000

CMD ["node", "dist/index.js"]
