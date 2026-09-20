// STAGE 6 — ESP-NOW badge gateway + local keyboard switches, USB serial output
//
// Earlier stages relayed badge button presses to the website over BLE
// (Web Bluetooth). Since the XIAO stays plugged into the laptop over USB,
// that hop is unnecessary: BLE notifications go through the connection's
// negotiated interval, which adds real, noticeable latency per message.
// This version drops BLE entirely and just prints each press to the native
// USB serial port, which the website reads directly via the Web Serial API
// (see src/routes/+page.svelte) - a raw byte stream with no radio scheduling.
//
// This stage also reads a set of keyboard switches wired directly to the
// XIAO's own GPIO pins (each switch: pin <-> GND, using the internal
// pull-up so a press reads LOW). Each press is reported:
//   - as an EVT line, exactly like a badge press, for the 5 switches wired
//     as ordinary player input into the bing bong game (see LOCAL_KEYS);
//   - as a VOL,UP / VOL,DOWN line for the D1/D10 switches specifically,
//     wired as dedicated volume controls instead - they never send EVT;
//   - as a separate KEY line naming the raw D-pin number, for every local
//     switch regardless of its action, read only by the /controller test
//     page, so wiring can be verified pin-by-pin without it being tangled
//     up in game/player/volume logic.
// Note: the ESP32-C6's USB port is a fixed-function USB-Serial/JTAG
// controller (SOC_USB_SERIAL_JTAG_SUPPORTED), not a full USB-OTG peripheral
// like the S2/S3 have, so it cannot present itself as a USB HID keyboard -
// this is why these switches show up as serial lines instead of as real
// system-wide keystrokes.
//
// Also relays the creature handshake both ways: a badge's HELLO goes up to
// the website as a serial line, and the website's ASSIGN command comes back
// down over serial to be unicast to that one badge (see
// src/lib/game-state.svelte.ts and badge_espnow_firmware/main/main.c).
//
// Output format, one line per event:
//   EVT,<mac>,<button>,<seq>\n
//   ACC,<mac>,<x>,<y>,<z>,<seq>\n
//   KEY,<d-pin>,<seq>\n
//   VOL,<UP|DOWN>,<seq>\n
//   HELLO,<mac>,<seq>\n
// e.g. EVT,28:84:85:EA:78:4C,B,97
//      ACC,28:84:85:EA:78:4C,120,-38,16200,412
//      KEY,3,5                              (local switch on D3, 5th local press)
//      VOL,UP,6                             (D1 pressed, 6th local press)
//      HELLO,28:84:85:EA:78:4C,3
//
// Input format, one line per command, from the website over serial:
//   ASSIGN,<mac>,<creature>\n
// e.g. ASSIGN,28:84:85:EA:78:4C,2
//
// Board: Boards Manager > esp32 (Espressif) >= 3.0.0
//        Tools > Board > XIAO_ESP32C6 (or ESP32C6 Dev Module)
// No extra libraries needed - esp_now.h / esp_wifi.h ship with the esp32
// board package, and BLE (NimBLE-Arduino) is no longer used.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

// ---- Must match badge_espnow_firmware/main/main.c ----
#define ESPNOW_MAGIC_BUTTON 0xB1
#define ESPNOW_MAGIC_ACCEL 0xB2
#define ESPNOW_MAGIC_HELLO 0xB3
#define ESPNOW_MAGIC_ASSIGN 0xB4
#define ESPNOW_CHANNEL 1

typedef struct __attribute__((packed)) {
  uint8_t magic;
  uint8_t button;
  uint16_t seq;
} espnow_button_msg_t;

typedef struct __attribute__((packed)) {
  uint8_t magic;
  int16_t x;
  int16_t y;
  int16_t z;
  uint16_t seq;
} espnow_accel_msg_t;

typedef struct __attribute__((packed)) {
  uint8_t magic;
  uint16_t seq;
} espnow_hello_msg_t;

typedef struct __attribute__((packed)) {
  uint8_t magic;
  uint8_t creature;
} espnow_assign_msg_t;

// ---- Local keyboard switches ----
// dPin is Seeed's silkscreen number for this board (see pins_arduino.h for
// the XIAO_ESP32C6 variant); "pin" is the Arduino constant Dn resolves to,
// which the core maps to the right underlying GPIO. Edit the letters here
// to match whatever each physical switch is actually meant to type.
// D1/D10 are wired as dedicated volume controls instead of game buttons -
// they report VOL,UP/VOL,DOWN and never send EVT, so they don't also act
// as a player's letter input.
enum LocalKeyAction { ACTION_BUTTON, ACTION_VOLUME_UP, ACTION_VOLUME_DOWN };

struct LocalKey {
  uint8_t pin;
  uint8_t dPin;
  LocalKeyAction action;
  char letter;  // only meaningful when action == ACTION_BUTTON
};

static const LocalKey LOCAL_KEYS[] = {
  { D1, 1, ACTION_VOLUME_UP, 0 },
  { D3, 3, ACTION_BUTTON, 'B' },
  { D6, 6, ACTION_BUTTON, 'C' },
  { D7, 7, ACTION_BUTTON, 'D' },
  { D8, 8, ACTION_BUTTON, 'E' },
  { D9, 9, ACTION_BUTTON, 'F' },
  { D10, 10, ACTION_VOLUME_DOWN, 0 },
};
static const int LOCAL_KEY_COUNT = sizeof(LOCAL_KEYS) / sizeof(LOCAL_KEYS[0]);

static bool localStable[LOCAL_KEY_COUNT];
static bool localLastRaw[LOCAL_KEY_COUNT];
static uint16_t localSeq = 0;
static String localSourceId;

// Auto-repeat while a volume switch is held: after an initial pause (so a
// quick tap stays a single step), it fires the same VOL line again every
// REPEAT_INTERVAL_MS, sliding the volume continuously for as long as it's
// held down. Only applies to ACTION_VOLUME_UP/DOWN - game buttons stay
// one-shot per press.
static const unsigned long REPEAT_DELAY_MS = 350;
static const unsigned long REPEAT_INTERVAL_MS = 60;
static unsigned long localPressStart[LOCAL_KEY_COUNT];
static unsigned long localLastRepeat[LOCAL_KEY_COUNT];

static void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len < 1) return;
  uint8_t magic = data[0];

  if (magic == ESPNOW_MAGIC_BUTTON && len == (int)sizeof(espnow_button_msg_t)) {
    const espnow_button_msg_t *msg = reinterpret_cast<const espnow_button_msg_t *>(data);
    if (!isalnum(msg->button)) return;

    Serial.printf("EVT,%02X:%02X:%02X:%02X:%02X:%02X,%c,%u\n",
                  info->src_addr[0], info->src_addr[1], info->src_addr[2],
                  info->src_addr[3], info->src_addr[4], info->src_addr[5],
                  msg->button, msg->seq);
  } else if (magic == ESPNOW_MAGIC_ACCEL && len == (int)sizeof(espnow_accel_msg_t)) {
    const espnow_accel_msg_t *msg = reinterpret_cast<const espnow_accel_msg_t *>(data);

    Serial.printf("ACC,%02X:%02X:%02X:%02X:%02X:%02X,%d,%d,%d,%u\n",
                  info->src_addr[0], info->src_addr[1], info->src_addr[2],
                  info->src_addr[3], info->src_addr[4], info->src_addr[5],
                  msg->x, msg->y, msg->z, msg->seq);
  } else if (magic == ESPNOW_MAGIC_HELLO && len == (int)sizeof(espnow_hello_msg_t)) {
    const espnow_hello_msg_t *msg = reinterpret_cast<const espnow_hello_msg_t *>(data);

    Serial.printf("HELLO,%02X:%02X:%02X:%02X:%02X:%02X,%u\n",
                  info->src_addr[0], info->src_addr[1], info->src_addr[2],
                  info->src_addr[3], info->src_addr[4], info->src_addr[5],
                  msg->seq);
  }
}

// Parses "AA:BB:CC:DD:EE:FF" into 6 bytes. Returns false (and leaves mac
// untouched) on anything malformed, so a corrupt serial line can't turn
// into a send to a garbage address.
static bool parseMac(const String &text, uint8_t mac[6]) {
  if (text.length() != 17) return false;
  uint8_t parsed[6];
  for (int i = 0; i < 6; i++) {
    if (i < 5 && text[i * 3 + 2] != ':') return false;
    char hex[3] = { text[i * 3], text[i * 3 + 1], '\0' };
    char *end;
    long value = strtol(hex, &end, 16);
    if (end != hex + 2) return false;
    parsed[i] = (uint8_t)value;
  }
  memcpy(mac, parsed, 6);
  return true;
}

// Adds mac as a unicast peer if it isn't already one - repeat ASSIGNs to the
// same badge (a manual reassign, or the join-race fallback) would otherwise
// fail with ESP_ERR_ESPNOW_EXIST.
static bool ensurePeer(const uint8_t mac[6]) {
  if (esp_now_is_peer_exist(mac)) return true;

  esp_now_peer_info_t peer = {0};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = ESPNOW_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  return esp_now_add_peer(&peer) == ESP_OK;
}

// Handles "ASSIGN,<mac>,<creature>\n" from the website and unicasts it to
// that one badge.
static void handleSerialLine(const String &line) {
  if (!line.startsWith("ASSIGN,")) return;

  int firstComma = line.indexOf(',');
  int secondComma = line.indexOf(',', firstComma + 1);
  if (secondComma < 0) return;

  String macText = line.substring(firstComma + 1, secondComma);
  String creatureText = line.substring(secondComma + 1);

  uint8_t mac[6];
  if (!parseMac(macText, mac)) return;

  long creature = creatureText.toInt();
  if (creature < 0 || creature > 3) return;

  if (!ensurePeer(mac)) {
    Serial.println("[espnow] failed to add peer for ASSIGN");
    return;
  }

  espnow_assign_msg_t msg = {
    .magic = ESPNOW_MAGIC_ASSIGN,
    .creature = (uint8_t)creature,
  };
  esp_now_send(mac, (const uint8_t *)&msg, sizeof(msg));
}

void setup() {
  Serial.begin(115200);
  // readStringUntil() defaults to a 1000ms timeout on a partial line, which
  // would stall the receive side of loop() for that long on every ragged
  // read - the whole point of dropping the old delay(1000).
  Serial.setTimeout(50);
  delay(1000);
  Serial.println("ESP-NOW badge gateway starting...");

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

  localSourceId = WiFi.macAddress();

  if (esp_now_init() != ESP_OK) {
    Serial.println("[espnow] init failed");
  } else {
    esp_now_register_recv_cb(onEspNowRecv);
    Serial.printf("[espnow] listening on channel %d, MAC %s\n",
                  ESPNOW_CHANNEL, localSourceId.c_str());
  }

  for (int i = 0; i < LOCAL_KEY_COUNT; i++) {
    pinMode(LOCAL_KEYS[i].pin, INPUT_PULLUP);
  }
  for (int i = 0; i < LOCAL_KEY_COUNT; i++) {
    localStable[i] = (digitalRead(LOCAL_KEYS[i].pin) == LOW);
    localLastRaw[i] = localStable[i];
  }
  Serial.printf("[keys] %d local switches ready\n", LOCAL_KEY_COUNT);
}

// Sends the VOL/KEY line pair for one volume key event (initial press or an
// auto-repeat tick while held).
static void sendVolumeEvent(const LocalKey &key) {
  localSeq++;
  Serial.printf("VOL,%s,%u\n", key.action == ACTION_VOLUME_UP ? "UP" : "DOWN", localSeq);
  Serial.printf("KEY,%u,%u\n", key.dPin, localSeq);
}

void loop() {
  unsigned long now = millis();

  // 2-sample debounce, same pattern as the badge firmware: only commit a
  // transition once the raw reading has been stable for one full poll.
  for (int i = 0; i < LOCAL_KEY_COUNT; i++) {
    bool raw = (digitalRead(LOCAL_KEYS[i].pin) == LOW);  // active-low
    if (raw == localLastRaw[i] && raw != localStable[i]) {
      localStable[i] = raw;
      if (raw) {  // released -> pressed edge
        localPressStart[i] = now;
        localLastRepeat[i] = now;
        if (LOCAL_KEYS[i].action == ACTION_BUTTON) {
          localSeq++;
          Serial.printf("EVT,%s,%c,%u\n", localSourceId.c_str(), LOCAL_KEYS[i].letter, localSeq);
          Serial.printf("KEY,%u,%u\n", LOCAL_KEYS[i].dPin, localSeq);
        } else {
          sendVolumeEvent(LOCAL_KEYS[i]);
        }
      }
    }
    localLastRaw[i] = raw;

    // Auto-repeat: only volume keys, and only once they've been held past
    // the initial delay, so a quick tap still produces exactly one step.
    bool isVolumeKey = (LOCAL_KEYS[i].action == ACTION_VOLUME_UP || LOCAL_KEYS[i].action == ACTION_VOLUME_DOWN);
    if (isVolumeKey && localStable[i] && (now - localPressStart[i]) > REPEAT_DELAY_MS &&
        (now - localLastRepeat[i]) > REPEAT_INTERVAL_MS) {
      localLastRepeat[i] = now;
      sendVolumeEvent(LOCAL_KEYS[i]);
    }
  }

  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() > 0) handleSerialLine(line);
  }

  delay(10);
}
