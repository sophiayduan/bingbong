#!/usr/bin/env bash
# Builds and flashes the receiver/gateway (XIAO ESP32-C6)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

FQBN="esp32:esp32:XIAO_ESP32C6"

if ! command -v arduino-cli >/dev/null 2>&1; then
	echo "arduino-cli not found on PATH" >&2
	exit 1
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

echo "flashing gateway on $PORT ($CHIP)"
arduino-cli compile --fqbn "$FQBN" xiao_espnow_gateway.ino
arduino-cli upload -p "$PORT" --fqbn "$FQBN" xiao_espnow_gateway.ino
