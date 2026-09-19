// Custom badge firmware: reads the 8 shift-register buttons + Start, and
// broadcasts each button press over ESP-NOW so an ESP32-C6 gateway nearby
// can pick it up (see the xiao_espnow_gateway sketch). Also brings up the
// ST7789 screen and displays a static QR code the whole time it's on.
//
// Hardware reference: badge.hackthenorth.com/custom-flash (ESP32-C3-MINI-1-N4).
// This firmware touches buttons, Wi-Fi/ESP-NOW, and the screen; it does not
// init the LEDs, accelerometer, or NFC.

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
#include "lcd.h"

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
// A broadcast frame, so any ESP-NOW-capable device nearby could technically
// receive it (no pairing needed for broadcast). The magic byte lets the
// gateway ignore anything that isn't from this firmware.
#define ESPNOW_MAGIC 0xB1
#define ESPNOW_CHANNEL 1

typedef struct __attribute__((packed)) {
    uint8_t magic;    // ESPNOW_MAGIC
    uint8_t button;   // ASCII code from BUTTON_CODE
    uint16_t seq;     // increments per press; gateway can spot loss/reorder
} espnow_msg_t;

static const uint8_t BROADCAST_ADDR[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static uint16_t s_seq = 0;

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
    espnow_msg_t msg = {
        .magic = ESPNOW_MAGIC,
        .button = (uint8_t)BUTTON_CODE[id],
        .seq = ++s_seq,
    };
    esp_err_t err = esp_now_send(BROADCAST_ADDR, (const uint8_t *)&msg, sizeof(msg));
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "sent button '%c' (seq %u)", msg.button, msg.seq);
    } else {
        ESP_LOGW(TAG, "esp_now_send failed for '%c': %s", msg.button, esp_err_to_name(err));
    }
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

    ESP_ERROR_CHECK(esp_now_init());

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

    esp_lcd_panel_handle_t panel = lcd_init();
    lcd_draw_image(panel);

    bool raw[8], stable[8], last_raw[8];
    hc165_read(stable);
    memcpy(last_raw, stable, sizeof(stable));

    bool start_stable = (gpio_get_level(PIN_START) == 0);
    bool start_last_raw = start_stable;

    ESP_LOGI(TAG, "Button poll loop starting.");

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

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
