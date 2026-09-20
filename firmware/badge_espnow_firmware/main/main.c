// Custom badge firmware: reads the 8 shift-register buttons + Start and the
// SC7A20HTR accelerometer, and broadcasts both over ESP-NOW so an ESP32-C6
// gateway nearby can pick them up (see the xiao_espnow_gateway sketch). Also
// drives the ST7789 screen through three states, entirely from information
// the badge already has locally - no extra wire messages needed:
//   "BINGBONG"                -> boot, before any ASSIGN has ever arrived
//   "PRESS ANY KEY TO JOIN"   -> ASSIGN received, no local button press yet
//   <creature name>           -> first local button press after ASSIGN
// (see the HELLO/ASSIGN handshake below and src/lib/game-state.svelte.ts).
//
// Hardware reference: badge.hackthenorth.com/custom-flash (ESP32-C3-MINI-1-N4).
// This firmware touches buttons, the accelerometer, Wi-Fi/ESP-NOW, and the
// screen; it does not init the LEDs or NFC.

#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "accel.h"
#include "lcd.h"
#include "creature_banners.h"

static const char *TAG = "badge_espnow";

// ---- Pin map (Custom Flash HAL guide) ----
#define PIN_HC165_DATA 7
#define PIN_HC165_LOAD 20
#define PIN_HC165_CLK  21
#define PIN_START      9

// Shift order out of the 74HC165, active-low: A, B, Home, Down, Left, Right,
// Up, Aux1 (A shifts out first). Index = shift position.
typedef enum {
    BTN_A = 0,
    BTN_B,
    BTN_HOME,
    BTN_DOWN,
    BTN_LEFT,
    BTN_RIGHT,
    BTN_UP,
    BTN_AUX1,
    BTN_START,  // not from the shift register; its own GPIO (also strapping pin)
    BTN_COUNT
} button_id_t;

static const char BUTTON_CODE[BTN_COUNT] = {
    'A', 'B', 'H', 'D', 'L', 'R', 'U', 'X', 'S',
};

// ---- ESP-NOW wire format ----
// Broadcast frames, so any ESP-NOW-capable device nearby could technically
// receive them (no pairing needed for broadcast). The magic byte lets the
// gateway ignore anything that isn't from this firmware, and tells the two
// message types apart (they're different sizes too, but magic is checked
// first).
#define ESPNOW_MAGIC_BUTTON 0xB1
#define ESPNOW_MAGIC_ACCEL 0xB2
// Handshake: badge broadcasts HELLO until the gateway's ASSIGN reply names a
// creature slot (see xiao_espnow_gateway.ino / src/lib/game-state.svelte.ts).
#define ESPNOW_MAGIC_HELLO 0xB3
#define ESPNOW_MAGIC_ASSIGN 0xB4
#define ESPNOW_CHANNEL 1

// Resend HELLO at this loop-count interval until assigned; the server
// re-sends the same creature for a repeat HELLO, so this is safe to retry
// forever with no separate ack.
#define HELLO_RETRY_LOOPS 200

// Accelerometer samples are broadcast at 1/ACCEL_SAMPLE_EVERY_N_LOOPS of the
// button poll rate (10 ms loop -> 50 ms / 20 Hz) so they don't dominate
// ESP-NOW airtime alongside button presses.
#define ACCEL_SAMPLE_EVERY_N_LOOPS 5

typedef struct __attribute__((packed)) {
    uint8_t magic;    // ESPNOW_MAGIC_BUTTON
    uint8_t button;   // ASCII code from BUTTON_CODE
    uint16_t seq;     // increments per press; gateway can spot loss/reorder
} espnow_button_msg_t;

typedef struct __attribute__((packed)) {
    uint8_t magic;    // ESPNOW_MAGIC_ACCEL
    int16_t x;
    int16_t y;
    int16_t z;
    uint16_t seq;     // increments per sample; gateway can spot loss/reorder
} espnow_accel_msg_t;

typedef struct __attribute__((packed)) {
    uint8_t magic;    // ESPNOW_MAGIC_HELLO
    uint16_t seq;
} espnow_hello_msg_t;

typedef struct __attribute__((packed)) {
    uint8_t magic;    // ESPNOW_MAGIC_ASSIGN
    uint8_t creature; // 0-3, see creature_banners.h
} espnow_assign_msg_t;

static const uint8_t BROADCAST_ADDR[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static uint16_t s_seq = 0;
static uint16_t s_accel_seq = 0;
static uint16_t s_hello_seq = 0;

static esp_lcd_panel_handle_t s_panel;
static volatile bool s_assigned = false;
// Set the instant a button on THIS badge is pressed, entirely locally - no
// server round trip needed, unlike s_assigned. Read from onEspNowRecv (the
// WiFi task) to decide what a fresh ASSIGN should draw.
static volatile bool s_joined = false;
static volatile bool s_redraw_pending = false;
static volatile const uint8_t *s_pending_banner = NULL;
static volatile uint8_t s_creature = 0;

static void hc165_gpio_init(void) {
    gpio_config_t data_cfg = {
        .pin_bit_mask = 1ULL << PIN_HC165_DATA,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&data_cfg);

    gpio_config_t out_cfg = {
        .pin_bit_mask = (1ULL << PIN_HC165_LOAD) | (1ULL << PIN_HC165_CLK),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&out_cfg);
    gpio_set_level(PIN_HC165_LOAD, 1);
    gpio_set_level(PIN_HC165_CLK, 0);

    gpio_config_t start_cfg = {
        .pin_bit_mask = 1ULL << PIN_START,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&start_cfg);
}

// Latches and shifts out 8 active-low bits in physical order
// A, B, Home, Down, Left, Right, Up, Aux1 (pressed[0] = A, ... pressed[7] = Aux1).
static void hc165_read(bool pressed[8]) {
    gpio_set_level(PIN_HC165_LOAD, 0);
    esp_rom_delay_us(2);
    gpio_set_level(PIN_HC165_LOAD, 1);
    esp_rom_delay_us(2);

    for (int i = 0; i < 8; i++) {
        pressed[i] = (gpio_get_level(PIN_HC165_DATA) == 0);  // active-low
        gpio_set_level(PIN_HC165_CLK, 1);
        esp_rom_delay_us(2);
        gpio_set_level(PIN_HC165_CLK, 0);
        esp_rom_delay_us(2);
    }
}

static void send_button(button_id_t id) {
    espnow_button_msg_t msg = {
        .magic = ESPNOW_MAGIC_BUTTON,
        .button = (uint8_t)BUTTON_CODE[id],
        .seq = ++s_seq,
    };
    esp_err_t err = esp_now_send(BROADCAST_ADDR, (const uint8_t *)&msg, sizeof(msg));
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "sent button '%c' (seq %u)", msg.button, msg.seq);
    } else {
        ESP_LOGW(TAG, "esp_now_send failed for '%c': %s", msg.button, esp_err_to_name(err));
    }

    // First press on this badge, ever: swap the "press any key to join"
    // screen for the assigned creature's name. Runs on the poll loop thread
    // already, so the draw happens right here instead of through the
    // s_redraw_pending handoff onEspNowRecv needs.
    if (s_assigned && !s_joined) {
        s_joined = true;
        lcd_draw_banner(s_panel, creature_banners[s_creature], "creature (first press)");
    }
}

static void send_accel(int16_t x, int16_t y, int16_t z) {
    espnow_accel_msg_t msg = {
        .magic = ESPNOW_MAGIC_ACCEL,
        .x = x,
        .y = y,
        .z = z,
        .seq = ++s_accel_seq,
    };
    esp_err_t err = esp_now_send(BROADCAST_ADDR, (const uint8_t *)&msg, sizeof(msg));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_now_send failed for accel sample: %s", esp_err_to_name(err));
    }
}

static void send_hello(void) {
    espnow_hello_msg_t msg = {
        .magic = ESPNOW_MAGIC_HELLO,
        .seq = ++s_hello_seq,
    };
    esp_err_t err = esp_now_send(BROADCAST_ADDR, (const uint8_t *)&msg, sizeof(msg));
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "sent hello (seq %u, assigned=%d joined=%d)", msg.seq, s_assigned, s_joined);
    } else {
        ESP_LOGW(TAG, "esp_now_send failed for hello: %s", esp_err_to_name(err));
    }
}

// Unicast from the gateway. Runs in the ESP-NOW/WiFi task, not the button
// poll loop - s_assigned/s_creature/s_redraw_pending are single bytes so
// plain reads/writes are enough to hand the value across without a lock.
// The actual redraw happens in the poll loop: it's ~15 blocking SPI waits,
// and ESP-IDF warns against lengthy work in this callback.
static void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
    (void)info;
    if (len != (int)sizeof(espnow_assign_msg_t)) return;
    const espnow_assign_msg_t *msg = (const espnow_assign_msg_t *)data;
    if (msg->magic != ESPNOW_MAGIC_ASSIGN) return;
    // Channel 1 carries other badges' broadcasts too; a 2-byte payload that
    // happens to start with 0xB4 parses as ASSIGN regardless of its origin,
    // so creature is untrusted and must be range-checked before it indexes
    // creature_banners[] - an out-of-range value there reads a garbage
    // pointer and crashes on the next redraw.
    if (msg->creature >= 4) {
        ESP_LOGW(TAG, "ignoring ASSIGN with out-of-range creature %u", msg->creature);
        return;
    }

    ESP_LOGI(TAG, "ASSIGN recv: creature=%u (was assigned=%d joined=%d)", msg->creature, s_assigned, s_joined);
    s_creature = msg->creature;
    s_assigned = true;
    // A reassign after this badge already joined (a manual swap mid-game)
    // shows the new creature directly; otherwise it's still waiting on a
    // first press, so "press any key to join" stands until that happens.
    s_pending_banner = s_joined ? creature_banners[msg->creature] : system_press_to_join_banner;
    s_redraw_pending = true;
}

static void espnow_init(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    // Full TX power (20dBm default) draws a PA current spike on every send
    // that a battery's higher source impedance can sag under - the brownout
    // detector is already at its least-sensitive Kconfig setting (2.51V), so
    // the fix is cutting the spike itself, not the threshold. 11dBm is
    // still comfortable for a badge-to-gateway link at a few meters.
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(44));

    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(onEspNowRecv));

    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, BROADCAST_ADDR, 6);
    peer.channel = ESPNOW_CHANNEL;
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = false;
    ESP_ERROR_CHECK(esp_now_add_peer(&peer));

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_STA, mac));
    ESP_LOGI(TAG, "ESP-NOW ready on channel %d. This badge's MAC: %02X:%02X:%02X:%02X:%02X:%02X",
             ESPNOW_CHANNEL, mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void app_main(void) {
    ESP_ERROR_CHECK(nvs_flash_init());
    hc165_gpio_init();
    espnow_init();

    if (!accel_init()) {
        ESP_LOGW(TAG, "accelerometer init failed - continuing without it");
    }

    s_panel = lcd_init();
    lcd_draw_banner(s_panel, system_bingbong_banner, "bingbong (boot)");

    bool raw[8], stable[8], last_raw[8];
    hc165_read(stable);
    memcpy(last_raw, stable, sizeof(stable));

    bool start_stable = (gpio_get_level(PIN_START) == 0);
    bool start_last_raw = start_stable;

    ESP_LOGI(TAG, "Button poll loop starting.");
    send_hello();

    uint32_t loop_count = 0;

    while (1) {
        hc165_read(raw);
        bool start_raw = (gpio_get_level(PIN_START) == 0);

        // 2-sample debounce: only commit a transition once the raw reading
        // has been stable for one full 10 ms poll interval.
        for (int i = 0; i < 8; i++) {
            if (raw[i] == last_raw[i] && raw[i] != stable[i]) {
                stable[i] = raw[i];
                if (stable[i]) {  // released -> pressed edge
                    send_button((button_id_t)i);
                }
            }
            last_raw[i] = raw[i];
        }

        if (start_raw == start_last_raw && start_raw != start_stable) {
            start_stable = start_raw;
            if (start_stable) {
                send_button(BTN_START);
            }
        }
        start_last_raw = start_raw;

        if (s_redraw_pending) {
            s_redraw_pending = false;
            const uint8_t *banner = (const uint8_t *)s_pending_banner;
            char label[32];
            if (banner == system_press_to_join_banner) {
                snprintf(label, sizeof(label), "press-to-join");
            } else {
                snprintf(label, sizeof(label), "creature %u (reassign)", s_creature);
            }
            lcd_draw_banner(s_panel, banner, label);
        }

        loop_count++;
        if (!s_assigned && loop_count % HELLO_RETRY_LOOPS == 0) {
            send_hello();
        }

        // Paused: accel broadcasts were rate-limiting ESP-NOW.
        // if (loop_count % ACCEL_SAMPLE_EVERY_N_LOOPS == 0) {
        //     int16_t x, y, z;
        //     if (accel_read(&x, &y, &z)) {
        //         send_accel(x, y, z);
        //     }
        // }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
