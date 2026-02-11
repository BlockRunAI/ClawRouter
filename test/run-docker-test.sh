#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "🐳 Building Docker test environment..."
docker build -f test/Dockerfile.test -t clawrouter-test .

echo ""
echo "🧪 Running model selection tests..."
docker run --rm \
    -v "$(pwd)/test/test-model-selection.sh:/test.sh:ro" \
    clawrouter-test \
    bash -c "chmod +x /test.sh && /test.sh"

echo ""
echo "✅ Docker tests completed successfully!"
