// STAGE 4 — ESP-NOW badge gateway, USB serial output
//
// Earlier stages relayed badge button presses to the website over BLE
// (Web Bluetooth). Since the XIAO stays plugged into the laptop over USB,
// that hop is unnecessary: BLE notifications go through the connection's
// negotiated interval, which adds real, noticeable latency per message.
// This version drops BLE entirely and just prints each press to the native
// USB serial port, which the website reads directly via the Web Serial API
// (see src/routes/+page.svelte) - a raw byte stream with no radio scheduling.
//
// Output format, one line per press:
//   EVT,<mac>,<button>,<seq>\n
// e.g. EVT,28:84:85:EA:78:4C,B,97
//
// Board: Boards Manager > esp32 (Espressif) >= 3.0.0
//        Tools > Board > XIAO_ESP32C6 (or ESP32C6 Dev Module)
// No extra libraries needed - esp_now.h / esp_wifi.h ship with the esp32
// board package, and BLE (NimBLE-Arduino) is no longer used.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---- Must match badge_espnow_firmware/main/main.c ----
#define ESPNOW_MAGIC 0xB1
#define ESPNOW_CHANNEL 1

typedef struct __attribute__((packed)) {
  uint8_t magic;
  uint8_t button;
  uint16_t seq;
} espnow_msg_t;

static void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != (int)sizeof(espnow_msg_t)) return;
  const espnow_msg_t *msg = reinterpret_cast<const espnow_msg_t *>(data);
  if (msg->magic != ESPNOW_MAGIC) return;
  if (!isalnum(msg->button)) return;

  Serial.printf("EVT,%02X:%02X:%02X:%02X:%02X:%02X,%c,%u\n",
                info->src_addr[0], info->src_addr[1], info->src_addr[2],
                info->src_addr[3], info->src_addr[4], info->src_addr[5],
                msg->button, msg->seq);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("ESP-NOW badge gateway starting...");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[espnow] init failed");
  } else {
    esp_now_register_recv_cb(onEspNowRecv);
    Serial.printf("[espnow] listening on channel %d, MAC %s\n",
                  ESPNOW_CHANNEL, WiFi.macAddress().c_str());
  }
}

void loop() {
  delay(1000);
}
