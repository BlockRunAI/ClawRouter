FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Copy ClawRouter source and build
COPY . /opt/clawrouter
WORKDIR /opt/clawrouter
RUN npm ci && npm run build

# Make package globally available
RUN npm link

# Create non-root test user
RUN useradd -m -s /bin/bash testuser

# Set up npm global prefix for testuser
USER testuser
RUN mkdir -p ~/.npm-global && \
    npm config set prefix ~/.npm-global
ENV PATH="/home/testuser/.npm-global/bin:${PATH}"

# Link clawrouter into testuser's space
RUN npm link @blockrun/clawrouter

# Create OpenClaw config directory
RUN mkdir -p ~/.openclaw/blockrun

# Run integration tests via vitest
CMD ["npx", "--prefix", "/opt/clawrouter", "vitest", "run", "--config", "/opt/clawrouter/vitest.integration.config.ts"]
