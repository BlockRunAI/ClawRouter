#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "🐳 Building Docker installation test environment..."
docker build -f test/Dockerfile.install-test -t clawrouter-install-test .

echo ""
echo "🧪 Running installation tests..."
docker run --rm clawrouter-install-test /home/testuser/docker-install-tests.sh

echo ""
echo "✅ Installation tests completed successfully!"
