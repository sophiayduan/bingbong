#!/usr/bin/env bash
# Builds and flashes the receiver/gateway (XIAO ESP32-C6)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

IDF_EXPORT="${IDF_EXPORT:-$HOME/esp/esp-idf/export.sh}"
if ! command -v idf.py >/dev/null 2>&1; then
	if [ ! -f "$IDF_EXPORT" ]; then
		echo "idf.py not found and $IDF_EXPORT doesn't exist - set IDF_EXPORT to your esp-idf export.sh" >&2
		exit 1
	fi
	# shellcheck disable=SC1090
	source "$IDF_EXPORT"
fi

PORT="${1:-}"
if [ -z "$PORT" ]; then
	CANDIDATES=(/dev/serial/by-id/*)
	if [ ${#CANDIDATES[@]} -ne 1 ] || [ ! -e "${CANDIDATES[0]}" ]; then
		echo "expected exactly one device in /dev/serial/by-id, found: ${CANDIDATES[*]-none}" >&2
		echo "usage: $0 [port]" >&2
		exit 1
	fi
	PORT="${CANDIDATES[0]}"
fi

CHIP=$(esptool.py --port "$PORT" chip_id 2>&1 | grep -oP 'Chip is \K[^ ]+' || true)
if [ "$CHIP" != "ESP32-C6" ]; then
	echo "device on $PORT identifies as '$CHIP', not ESP32-C6 - refusing to flash gateway firmware to it" >&2
	exit 1
fi

if [ ! -f sdkconfig ]; then
	idf.py set-target esp32c6
fi

echo "flashing gateway on $PORT ($CHIP)"
idf.py build
idf.py -p "$PORT" flash
