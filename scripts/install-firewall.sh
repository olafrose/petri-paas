#!/bin/sh
# Installs petri.'s egress filtering on this host (run as root):
#   sudo scripts/install-firewall.sh            install or update, and apply
#   sudo scripts/install-firewall.sh --remove   remove it again
# Then check it with scripts/probe-egress.sh. Needs nftables
# (Debian/Ubuntu: apt install nftables) and systemd.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
unit=/etc/systemd/system/petri-firewall.service

if [ "$(id -u)" != 0 ]; then
	echo "Run as root (sudo $0)." >&2
	exit 1
fi

if [ "${1:-}" = --remove ]; then
	# Docker requires the firewall, so stopping it stops Docker first:
	# nothing runs unfiltered in between. Start Docker again afterwards.
	systemctl disable --now petri-firewall.service 2>/dev/null || true
	rm -f "$unit" /etc/petri/petri.nft
	rmdir /etc/petri 2>/dev/null || true
	systemctl daemon-reload
	systemctl start docker.service
	echo "Removed. Apps and builds can reach the LAN again."
	exit 0
fi

if [ ! -x /usr/sbin/nft ]; then
	echo "nftables is missing: apt install nftables" >&2
	exit 1
fi
# Refuse a broken file before replacing a working one.
nft -c -f "$here/infrastructure/firewall/petri.nft"

install -D -m 0644 "$here/infrastructure/firewall/petri.nft" /etc/petri/petri.nft
install -m 0644 "$here/infrastructure/firewall/petri-firewall.service" "$unit"
systemctl daemon-reload
systemctl enable petri-firewall.service
# Reloading swaps the rules in one step; never a moment without them.
systemctl reload-or-restart petri-firewall.service
nft list table inet petri >/dev/null
echo "Installed and active. Check it with: scripts/probe-egress.sh"
