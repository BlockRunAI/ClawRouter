#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Install Caddy if missing
if ! command -v caddy &>/dev/null; then
  echo "Installing Caddy..."
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
  # Stop the default caddy service — we use our own
  sudo systemctl disable --now caddy 2>/dev/null || true
fi

echo "Building proxy..."
npm run build --prefix "$SCRIPT_DIR/../proxy"

echo "Installing ClawRouter systemd services..."

sudo cp "$SCRIPT_DIR/clawrouter-scorer.service" /etc/systemd/system/
sudo cp "$SCRIPT_DIR/clawrouter-proxy.service" /etc/systemd/system/
sudo cp "$SCRIPT_DIR/caddy.service" /etc/systemd/system/clawrouter-caddy.service
sudo systemctl daemon-reload

sudo systemctl enable --now clawrouter-scorer
sudo systemctl enable --now clawrouter-proxy
sudo systemctl enable --now clawrouter-caddy

# Add local DNS entries if missing
for host in router.local dashboard.local; do
  grep -q "$host" /etc/hosts || echo "127.0.0.1 $host" | sudo tee -a /etc/hosts
done

echo "Done. Status:"
systemctl status clawrouter-scorer --no-pager -l
echo "---"
systemctl status clawrouter-proxy --no-pager -l
echo "---"
systemctl status clawrouter-caddy --no-pager -l
