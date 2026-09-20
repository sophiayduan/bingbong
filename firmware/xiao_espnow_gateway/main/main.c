// ESP-NOW badge gateway + local keyboard switches, native USB serial output.
//
// Rewritten from the original Arduino sketch straight onto ESP-IDF: same
// wire protocol, same board (XIAO ESP32-C6), no Arduino core in the build.
//
// Relays badge presses to the website over the native USB port (the browser
// reads it directly via the Web Serial API - see src/routes/+page.svelte),
// and relays the creature handshake both ways: a badge's HELLO goes up to
// the website as a serial line, and the website's ASSIGN command comes back
// down over serial to be unicast to that one badge (see
// src/lib/game-state.svelte.ts and badge_espnow_firmware/main/main.c).
//
// Also reads a set of keyboard switches wired directly to the board's own
// GPIO pins (each switch: pin <-> GND, using the internal pull-up so a press
// reads low). This controller is purely a utility surface (volume, advancing
// screens, etc.) - it never sends EVT and so can never play a note or occupy
// a player/creature slot; only real badges do that. Each press is reported:
//   - as a VOL,UP / VOL,DOWN line for the D1/D10 switches, wired as
//     dedicated volume controls;
//   - as a NEXT line for D7, wired as a dedicated "advance the intro screen"
//     control. Kept as its own line (rather than having the website react to
//     "any D press") because a badge's own DOWN button sends letter 'D', and
//     that must not also advance the intro screen;
//   - D4/D6/D8/D9 are currently unassigned (ACTION_NONE) - reserved for
//     future minor controls, deliberately not wired to any game input;
//   - as a separate KEY line naming the raw D-pin number, for every local
//     switch regardless of its action (including the unassigned ones), read
//     only by the /controller test page so wiring can be verified pin-by-pin;
//   - as a GOOSE line (a toggle, not an on/off state) whenever all 7 local
//     switches are held down at once.
//
// Output format, one line per event:
//   EVT,<mac>,<button>,<seq>\n
//   ACC,<mac>,<x>,<y>,<z>,<seq>\n
//   KEY,<d-pin>,<seq>\n
//   VOL,<UP|DOWN>,<seq>\n
//   NEXT,<seq>\n
//   GOOSE,<seq>\n
//   HELLO,<mac>,<seq>\n
// e.g. EVT,28:84:85:EA:78:4C,B,97
//      ACC,28:84:85:EA:78:4C,120,-38,16200,412
//      KEY,4,5                              (local switch on D4, 5th local press; D4 is
//                                            currently ACTION_NONE, so this is the only
//                                            line a D4 press produces)
//      VOL,UP,6                             (D1 pressed, 6th local press)
//      NEXT,7                               (D7 pressed, 7th local press)
//      GOOSE,8                              (all 7 local switches held at once)
//      HELLO,28:84:85:EA:78:4C,3
//
// Input format, one line per command, from the website over serial:
//   ASSIGN,<mac>,<creature>\n
// e.g. ASSIGN,28:84:85:EA:78:4C,2

#include <ctype.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

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
// GPIO numbers are the XIAO ESP32-C6's Dn silkscreen mapping (Seeed's
// variants/XIAO_ESP32C6/pins_arduino.h, back when this was built on the
// Arduino core): D1=1 D4=22 D6=16 D7=17 D8=19 D9=20 D10=18.
// No ACTION_BUTTON on purpose: this controller is a utility surface only
// (volume, screen navigation, ...) and must never be able to produce a
// badge-style EVT, which is what makes a press count as player/character
// input in the website's game logic.
typedef enum { ACTION_NONE, ACTION_VOLUME_UP, ACTION_VOLUME_DOWN, ACTION_NEXT } local_key_action_t;

typedef struct {
    gpio_num_t pin;
    uint8_t d_pin;
    local_key_action_t action;
} local_key_t;

static const local_key_t LOCAL_KEYS[] = {
    {GPIO_NUM_1, 1, ACTION_VOLUME_UP},  {GPIO_NUM_22, 4, ACTION_NONE},   {GPIO_NUM_16, 6, ACTION_NONE},
    {GPIO_NUM_17, 7, ACTION_NEXT},      {GPIO_NUM_19, 8, ACTION_NONE},   {GPIO_NUM_20, 9, ACTION_NONE},
    {GPIO_NUM_18, 10, ACTION_VOLUME_DOWN},
};
#define LOCAL_KEY_COUNT (sizeof(LOCAL_KEYS) / sizeof(LOCAL_KEYS[0]))

static bool s_local_stable[LOCAL_KEY_COUNT];
static bool s_local_last_raw[LOCAL_KEY_COUNT];
static uint32_t s_local_press_start[LOCAL_KEY_COUNT];
static uint32_t s_local_last_repeat[LOCAL_KEY_COUNT];
static uint16_t s_local_seq = 0;
static char s_local_source_id[18]; // "AA:BB:CC:DD:EE:FF\0"

// Chord: all 7 local switches held down at once toggles goose mode. Edge-
// detected off the already-debounced s_local_stable[] states (checked after
// the per-key loop settles them for this poll), so it fires exactly once per
// chord rather than repeatedly for as long as it's held.
static bool s_all_keys_held = false;

// Auto-repeat while a volume switch is held: after an initial pause (so a
// quick tap stays a single step), it fires the same VOL line again every
// REPEAT_INTERVAL_MS, sliding the volume continuously for as long as it's
// held down. Only applies to ACTION_VOLUME_UP/DOWN.
#define REPEAT_DELAY_MS 350
#define REPEAT_INTERVAL_MS 60

static uint32_t millis(void) { return (uint32_t)(esp_timer_get_time() / 1000); }

static void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    if (len < 1) return;
    uint8_t magic = data[0];
    const uint8_t *mac = info->src_addr;

    if (magic == ESPNOW_MAGIC_BUTTON && len == (int)sizeof(espnow_button_msg_t)) {
        const espnow_button_msg_t *msg = (const espnow_button_msg_t *)data;
        if (!isalnum((unsigned char)msg->button)) return;
        printf("EVT,%02X:%02X:%02X:%02X:%02X:%02X,%c,%u\n", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
               msg->button, msg->seq);
    } else if (magic == ESPNOW_MAGIC_ACCEL && len == (int)sizeof(espnow_accel_msg_t)) {
        const espnow_accel_msg_t *msg = (const espnow_accel_msg_t *)data;
        printf("ACC,%02X:%02X:%02X:%02X:%02X:%02X,%d,%d,%d,%u\n", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
               msg->x, msg->y, msg->z, msg->seq);
    } else if (magic == ESPNOW_MAGIC_HELLO && len == (int)sizeof(espnow_hello_msg_t)) {
        const espnow_hello_msg_t *msg = (const espnow_hello_msg_t *)data;
        printf("HELLO,%02X:%02X:%02X:%02X:%02X:%02X,%u\n", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], msg->seq);
    }
}

// Parses "AA:BB:CC:DD:EE:FF" into 6 bytes. Returns false (and leaves mac
// untouched) on anything malformed, so a corrupt serial line can't turn into
// a send to a garbage address.
static bool parse_mac(const char *text, uint8_t mac[6]) {
    if (strlen(text) != 17) return false;
    uint8_t parsed[6];
    for (int i = 0; i < 6; i++) {
        if (i < 5 && text[i * 3 + 2] != ':') return false;
        char hex[3] = {text[i * 3], text[i * 3 + 1], '\0'};
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
static bool ensure_peer(const uint8_t mac[6]) {
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
static void handle_serial_line(const char *line) {
    if (strncmp(line, "ASSIGN,", 7) != 0) return;

    const char *mac_start = line + 7;
    const char *first_comma = strchr(mac_start, ',');
    if (!first_comma) return;

    char mac_text[18];
    size_t mac_len = (size_t)(first_comma - mac_start);
    if (mac_len >= sizeof(mac_text)) return;
    memcpy(mac_text, mac_start, mac_len);
    mac_text[mac_len] = '\0';

    uint8_t mac[6];
    if (!parse_mac(mac_text, mac)) return;

    long creature = strtol(first_comma + 1, NULL, 10);
    if (creature < 0 || creature > 3) return;

    if (!ensure_peer(mac)) {
        printf("[espnow] failed to add peer for ASSIGN\n");
        return;
    }

    espnow_assign_msg_t msg = {.magic = ESPNOW_MAGIC_ASSIGN, .creature = (uint8_t)creature};
    esp_now_send(mac, (const uint8_t *)&msg, sizeof(msg));
}

// Blocks on stdin (the same native USB port the browser's Web Serial reads
// EVT/ACC/HELLO from) waiting for ASSIGN lines from the website. Runs in its
// own task since fgets() blocks, and the local key scan below can't wait on it.
static void serial_task(void *arg) {
    (void)arg;
    char line[64];
    while (true) {
        if (fgets(line, sizeof(line), stdin) == NULL) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
        if (len > 0) handle_serial_line(line);
    }
}

// Sends the VOL/KEY line pair for one volume key event (initial press or an
// auto-repeat tick while held).
static void send_volume_event(const local_key_t *key) {
    s_local_seq++;
    printf("VOL,%s,%u\n", key->action == ACTION_VOLUME_UP ? "UP" : "DOWN", s_local_seq);
    printf("KEY,%u,%u\n", key->d_pin, s_local_seq);
}

void app_main(void) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    printf("ESP-NOW badge gateway starting...\n");

    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE));

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, mac));
    snprintf(s_local_source_id, sizeof(s_local_source_id), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2],
             mac[3], mac[4], mac[5]);

    if (esp_now_init() != ESP_OK) {
        printf("[espnow] init failed\n");
    } else {
        ESP_ERROR_CHECK(esp_now_register_recv_cb(onEspNowRecv));
        printf("[espnow] listening on channel %d, MAC %s\n", ESPNOW_CHANNEL, s_local_source_id);
    }

    gpio_config_t io_conf = {
        .intr_type = GPIO_INTR_DISABLE,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
    };
    for (size_t i = 0; i < LOCAL_KEY_COUNT; i++) {
        io_conf.pin_bit_mask = 1ULL << LOCAL_KEYS[i].pin;
        ESP_ERROR_CHECK(gpio_config(&io_conf));
    }
    for (size_t i = 0; i < LOCAL_KEY_COUNT; i++) {
        s_local_stable[i] = (gpio_get_level(LOCAL_KEYS[i].pin) == 0);
        s_local_last_raw[i] = s_local_stable[i];
    }
    printf("[keys] %u local switches ready\n", (unsigned)LOCAL_KEY_COUNT);

    xTaskCreate(serial_task, "serial_rx", 4096, NULL, 5, NULL);

    while (true) {
        uint32_t now = millis();

        // 2-sample debounce, same pattern as the badge firmware: only commit
        // a transition once the raw reading has been stable for one full poll.
        for (size_t i = 0; i < LOCAL_KEY_COUNT; i++) {
            bool raw = (gpio_get_level(LOCAL_KEYS[i].pin) == 0); // active-low
            if (raw == s_local_last_raw[i] && raw != s_local_stable[i]) {
                s_local_stable[i] = raw;
                if (raw) { // released -> pressed edge
                    s_local_press_start[i] = now;
                    s_local_last_repeat[i] = now;
                    switch (LOCAL_KEYS[i].action) {
                        case ACTION_NONE:
                            // Unassigned pin: still report KEY so wiring can
                            // be verified on the /controller test page, but
                            // nothing that could ever register as game/
                            // player input.
                            s_local_seq++;
                            printf("KEY,%u,%u\n", LOCAL_KEYS[i].d_pin, s_local_seq);
                            break;
                        case ACTION_NEXT:
                            s_local_seq++;
                            printf("NEXT,%u\n", s_local_seq);
                            printf("KEY,%u,%u\n", LOCAL_KEYS[i].d_pin, s_local_seq);
                            break;
                        case ACTION_VOLUME_UP:
                        case ACTION_VOLUME_DOWN:
                            send_volume_event(&LOCAL_KEYS[i]);
                            break;
                    }
                }
            }
            s_local_last_raw[i] = raw;

            // Auto-repeat: only volume keys, and only once they've been held
            // past the initial delay, so a quick tap still produces exactly
            // one step.
            bool is_volume_key = (LOCAL_KEYS[i].action == ACTION_VOLUME_UP || LOCAL_KEYS[i].action == ACTION_VOLUME_DOWN);
            if (is_volume_key && s_local_stable[i] && (now - s_local_press_start[i]) > REPEAT_DELAY_MS &&
                (now - s_local_last_repeat[i]) > REPEAT_INTERVAL_MS) {
                s_local_last_repeat[i] = now;
                send_volume_event(&LOCAL_KEYS[i]);
            }
        }

        bool now_all_held = true;
        for (size_t i = 0; i < LOCAL_KEY_COUNT; i++) {
            if (!s_local_stable[i]) {
                now_all_held = false;
                break;
            }
        }
        if (now_all_held && !s_all_keys_held) {
            s_local_seq++;
            printf("GOOSE,%u\n", s_local_seq);
        }
        s_all_keys_held = now_all_held;

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
