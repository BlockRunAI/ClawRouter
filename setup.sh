#!/bin/bash
set -e

SERVICE_NAME="clawrouter"
SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
NODE_PATH="$HOME/.nvm/versions/node/v22.22.0/bin/node"
WORK_DIR="$HOME/ClawRouter"
ENV_FILE="$HOME/.claw-proxy-env"

mkdir -p "$HOME/.config/systemd/user"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=ClawRouter - OpenAI-compatible LLM routing proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$WORK_DIR
ExecStart=$NODE_PATH $WORK_DIR/dist/index.js
EnvironmentFile=$ENV_FILE
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

echo "✓ Service file created at $SERVICE_FILE"
echo ""
echo "Next steps:"
echo "1. Create $ENV_FILE with your environment variables"
echo "2. Run: systemctl --user daemon-reload"
echo "3. Run: systemctl --user enable $SERVICE_NAME"
echo "4. Run: systemctl --user start $SERVICE_NAME"
echo "5. Check status: systemctl --user status $SERVICE_NAME"
