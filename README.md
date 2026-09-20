# bingbong

badge midi remotes but it's a rythm party game (with a receiver/relay macropad board)

## Requirements

- Node.js + npm
- ESP-IDF
- arduino-cli with the `esp32:esp32` installed
- `esptool.py` on PATH

## Flashing

```bash
# badge (ESP32-C3)
./firmware/badge_espnow_firmware/flash.sh [port]

# gateway/receiver (ESP32-C6)
./firmware/xiao_espnow_gateway/flash.sh [port]
```

(port is autodetected if ommited)

## Web app

```bash
npm install
npm run dev
```
