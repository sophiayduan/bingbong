// ST7789 bring-up and a name-banner renderer.
//
// Pin map and init fixups (invert_color/swap_xy/mirror) are exactly as
// documented in the Custom Flash HAL guide: SPI2, MOSI=10, CLK=1, CS=2,
// DC=0, RST=4, 40 MHz, mode 0, RGB565. After swap_xy+mirror the usable
// drawing area is the same 320x240 landscape orientation the stock badge
// UI uses.

#include "lcd.h"
#include "creature_banners.h"

#include <stdbool.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define PIN_LCD_MOSI 10
#define PIN_LCD_CLK 1
#define PIN_LCD_CS 2
#define PIN_LCD_DC 0
#define PIN_LCD_RST 4

#define LCD_SPI_HOST SPI2_HOST
#define LCD_H_RES 320
#define LCD_V_RES 240

static const char *TAG = "lcd";

#define COLOR_WHITE 0xFFFF
#define COLOR_BLACK 0x0000

// Staging buffer for one band's worth of pixels: the SPI DMA engine can't
// source from flash-mapped rodata directly, so drawing a stored image goes
// through here a band at a time - a few KB instead of a full 320x240
// (153,600-byte) framebuffer.
#define BAND_ROWS 16
static uint16_t s_band[BAND_ROWS * LCD_H_RES];

// esp_lcd_panel_draw_bitmap() queues the SPI transfer asynchronously and
// keeps a pointer to s_band rather than copying it - it does NOT block
// until the data is actually on the wire. Reusing s_band for the next band
// before the DMA engine has finished reading the previous one corrupts
// whatever's still in flight (this is what caused the QR glitching: fast
// alternating detail shows a torn buffer far more visibly than a flat
// background does). This semaphore, given from the panel IO's completion
// callback, lets draw_band() wait for each transfer to actually finish
// before touching the buffer again.
static SemaphoreHandle_t s_flush_done;

static bool IRAM_ATTR on_color_trans_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *edata,
                                           void *user_ctx) {
    BaseType_t high_task_woken = pdFALSE;
    xSemaphoreGiveFromISR(s_flush_done, &high_task_woken);
    return high_task_woken == pdTRUE;
}

// Draws one band and blocks until the SPI transfer has actually completed,
// so the caller can safely overwrite s_band right after this returns.
static void draw_band(esp_lcd_panel_handle_t panel, int y, int rows) {
    esp_lcd_panel_draw_bitmap(panel, 0, y, LCD_H_RES, y + rows, s_band);
    xSemaphoreTake(s_flush_done, portMAX_DELAY);
}

esp_lcd_panel_handle_t lcd_init(void) {
    s_flush_done = xSemaphoreCreateBinary();

    spi_bus_config_t buscfg = {
        .mosi_io_num = PIN_LCD_MOSI,
        .miso_io_num = -1,
        .sclk_io_num = PIN_LCD_CLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = BAND_ROWS * LCD_H_RES * sizeof(uint16_t),
    };
    ESP_ERROR_CHECK(spi_bus_initialize(LCD_SPI_HOST, &buscfg, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io_handle = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = PIN_LCD_CS,
        .dc_gpio_num = PIN_LCD_DC,
        .spi_mode = 0,
        .pclk_hz = 40 * 1000 * 1000,
        .trans_queue_depth = 10,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .on_color_trans_done = on_color_trans_done,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_SPI_HOST, &io_config, &io_handle));

    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        // The ESP32-C3 stores our uint16_t color values little-endian; tell
        // the panel to expect that instead of the driver's big-endian
        // default. Pure black/white (QR) is byte-order-invariant so this
        // bug was latent until a full-color image needed correct RGB565.
        .data_endian = LCD_RGB_DATA_ENDIAN_LITTLE,
        .bits_per_pixel = 16,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io_handle, &panel_config, &panel));

    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, true, false));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

    ESP_LOGI(TAG, "ST7789 initialized");
    return panel;
}

static void fill_white(esp_lcd_panel_handle_t panel, int y0, int y1) {
    int y = y0;
    while (y < y1) {
        int rows = y1 - y;
        if (rows > BAND_ROWS) rows = BAND_ROWS;
        for (int i = 0; i < rows * LCD_H_RES; i++) {
            s_band[i] = COLOR_WHITE;
        }
        draw_band(panel, y, rows);
        y += rows;
    }
}

void lcd_draw_banner(esp_lcd_panel_handle_t panel, const uint8_t *banner, const char *label) {
    _Static_assert(CREATURE_BANNER_WIDTH == LCD_H_RES, "creature_banners.h must match panel width");
    _Static_assert(CREATURE_BANNER_HEIGHT % BAND_ROWS == 0, "banner height must be a whole number of bands");

    ESP_LOGI(TAG, "drawing banner '%s'", label);

    int y_offset = (LCD_V_RES - CREATURE_BANNER_HEIGHT) / 2;

    fill_white(panel, 0, y_offset);

    // Banner is a 1bpp mask (MSB-first per row-byte); expand it to RGB565
    // into s_band one band at a time instead of storing the full-color
    // pixels - it's pure black-on-white text, so this loses nothing and
    // shrinks four banners from ~120KB of rodata to ~7.7KB.
    for (int src_y = 0; src_y < CREATURE_BANNER_HEIGHT; src_y += BAND_ROWS) {
        for (int row = 0; row < BAND_ROWS; row++) {
            const uint8_t *row_bits = &banner[(src_y + row) * CREATURE_BANNER_BYTES_PER_ROW];
            uint16_t *row_pixels = &s_band[row * LCD_H_RES];
            for (int x = 0; x < LCD_H_RES; x++) {
                bool set = (row_bits[x / 8] >> (7 - (x % 8))) & 1;
                row_pixels[x] = set ? COLOR_BLACK : COLOR_WHITE;
            }
        }
        draw_band(panel, y_offset + src_y, BAND_ROWS);
    }

    fill_white(panel, y_offset + CREATURE_BANNER_HEIGHT, LCD_V_RES);
}
