#include "led.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "led";

#define LED_GPIO 3
#define LED_COUNT 6

// Physical position -> strip index, looking at the badge face (see
// custom-firmware-hal.md): 0 UpperLeft, 1 UpperRight, 2 MiddleRight,
// 3 BottomRight, 4 BottomLeft, 5 MiddleLeft. "Corners" skips the two
// middle-edge LEDs (2, 5).
static const uint32_t CORNER_INDICES[] = {0, 1, 3, 4};
#define CORNER_COUNT (sizeof(CORNER_INDICES) / sizeof(CORNER_INDICES[0]))

typedef struct {
    uint8_t r, g, b;
} rgb_t;

// One color per creature id (0-3) - matches this same slot's on-screen color
// in the web UI (PLAYER_COLORS in game-state.svelte.ts: rose/sky/emerald/
// amber-500), so the physical LED and the on-screen circle agree.
static const rgb_t CREATURE_COLORS[4] = {
    {244, 63, 94},   // Cat - rose-500
    {14, 165, 233},  // Baby Chick - sky-500
    {16, 185, 129},  // Canada Goose - emerald-500
    {245, 158, 11},  // Turkey - amber-500
};

// 6 LEDs at full color can brown out the board on AA power (see
// custom-firmware-hal.md section 6) - scale well down from that.
#define BRIGHTNESS_NUM 3
#define BRIGHTNESS_DEN 20 // ~12%

#define FLASH_COUNT 3
#define FLASH_ON_MS 150
#define FLASH_OFF_MS 150

led_strip_handle_t led_init(void) {
    led_strip_config_t strip_config = {
        .strip_gpio_num = LED_GPIO,
        .max_leds = LED_COUNT,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
    };

    led_strip_handle_t strip;
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &rmt_config, &strip));
    led_strip_clear(strip);
    ESP_LOGI(TAG, "WS2812 strip ready on GPIO%d, %d LEDs", LED_GPIO, LED_COUNT);
    return strip;
}

void led_flash_creature(led_strip_handle_t strip, uint8_t creature) {
    if (creature >= 4) return;
    rgb_t c = CREATURE_COLORS[creature];
    uint8_t r = (uint8_t)((int)c.r * BRIGHTNESS_NUM / BRIGHTNESS_DEN);
    uint8_t g = (uint8_t)((int)c.g * BRIGHTNESS_NUM / BRIGHTNESS_DEN);
    uint8_t b = (uint8_t)((int)c.b * BRIGHTNESS_NUM / BRIGHTNESS_DEN);

    for (int flash = 0; flash < FLASH_COUNT; flash++) {
        for (size_t i = 0; i < CORNER_COUNT; i++) {
            led_strip_set_pixel(strip, CORNER_INDICES[i], r, g, b);
        }
        led_strip_refresh(strip);
        vTaskDelay(pdMS_TO_TICKS(FLASH_ON_MS));

        led_strip_clear(strip);
        vTaskDelay(pdMS_TO_TICKS(FLASH_OFF_MS));
    }
}
