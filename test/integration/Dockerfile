FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally (peer dependency)
# --ignore-scripts avoids native compilation of optional deps like @discordjs/opus
RUN npm install -g --ignore-scripts openclaw@latest

# Copy ClawRouter source and build
WORKDIR /opt/clawrouter
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Create OpenClaw config directory
RUN mkdir -p ~/.openclaw/blockrun

# Run integration tests
CMD ["npx", "vitest", "run", "--config", "vitest.integration.config.ts"]
