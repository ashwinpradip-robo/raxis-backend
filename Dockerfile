# ─────────────────────────────────────────────────────────────────────────────
# RAXIS Backend Dockerfile for Render deployment
# Uses official Puppeteer image (has Chromium + libs), upgraded to Node 22
# Node 22 is required by @supabase/supabase-js 2.110+ (WebSocket support)
# ─────────────────────────────────────────────────────────────────────────────

FROM ghcr.io/puppeteer/puppeteer:22.15.0

# Puppeteer image runs as non-root user 'pptruser'
# Switch to root to install Node 22, then switch back
USER root

# Install Node 22 (base image ships with Node 20 which lacks native WebSocket)
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Return to pptruser for the app
USER pptruser
WORKDIR /home/pptruser/app

# Copy package files first (Docker layer caching)
COPY --chown=pptruser:pptruser package*.json ./

# Skip Puppeteer's Chromium download (image already has it)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
RUN npm install

# Copy source
COPY --chown=pptruser:pptruser . .

# Build TypeScript
RUN npm run build

# Copy prompts folder into dist so runtime can find them
RUN cp -r src/prompts dist/prompts

# Render sets PORT dynamically
ENV PORT=10000
EXPOSE 10000

CMD ["node", "dist/index.js"]
