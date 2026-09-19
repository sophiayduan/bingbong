// ST7789 bring-up and a simple QR code renderer.
//
// Pin map and init fixups (invert_color/swap_xy/mirror) are exactly as
// documented in the Custom Flash HAL guide: SPI2, MOSI=10, CLK=1, CS=2,
// DC=0, RST=4, 40 MHz, mode 0, RGB565. After swap_xy+mirror the usable
// drawing area is the same 320x240 landscape orientation the stock badge
// UI uses.

#include "lcd.h"
#include "qr_code.h"

#include <string.h>
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"

#define PIN_LCD_MOSI 10
#define PIN_LCD_CLK 1
#define PIN_LCD_CS 2
#define PIN_LCD_DC 0
#define PIN_LCD_RST 4

#define LCD_SPI_HOST SPI2_HOST
#define LCD_H_RES 320
#define LCD_V_RES 240

#define COLOR_WHITE 0xFFFF
#define COLOR_BLACK 0x0000

// Standard QR quiet-zone recommendation is >= 4 modules of blank margin.
#define QR_QUIET_MODULES 4

static const char *TAG = "lcd";

// One reusable band buffer, filled with a single color per fill_rect() call
// and streamed in horizontal-row chunks - keeps RAM use to a few KB instead
// of needing a full 320x240 framebuffer.
#define BAND_ROWS 16
static uint16_t s_band[BAND_ROWS * LCD_H_RES];

static void fill_rect(esp_lcd_panel_handle_t panel, int x0, int y0, int x1, int y1, uint16_t color) {
    int width = x1 - x0;
    if (width <= 0 || y1 <= y0) return;

    int y = y0;
    while (y < y1) {
        int rows = y1 - y;
        if (rows > BAND_ROWS) rows = BAND_ROWS;
        int count = width * rows;
        for (int i = 0; i < count; i++) {
            s_band[i] = color;
        }
        esp_lcd_panel_draw_bitmap(panel, x0, y, x1, y + rows, s_band);
        y += rows;
    }
}

esp_lcd_panel_handle_t lcd_init(void) {
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
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_SPI_HOST, &io_config, &io_handle));

    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
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

void lcd_draw_qr(esp_lcd_panel_handle_t panel) {
    int smaller_dim = LCD_H_RES < LCD_V_RES ? LCD_H_RES : LCD_V_RES;
    int module_size = smaller_dim / (QR_SIZE + 2 * QR_QUIET_MODULES);
    if (module_size < 1) module_size = 1;

    int total_px = module_size * (QR_SIZE + 2 * QR_QUIET_MODULES);
    int origin_x = (LCD_H_RES - total_px) / 2;
    int origin_y = (LCD_V_RES - total_px) / 2;
    int qr_x0 = origin_x + QR_QUIET_MODULES * module_size;
    int qr_y0 = origin_y + QR_QUIET_MODULES * module_size;

    fill_rect(panel, 0, 0, LCD_H_RES, LCD_V_RES, COLOR_WHITE);

    for (int row = 0; row < QR_SIZE; row++) {
        for (int col = 0; col < QR_SIZE; col++) {
            if (!qr_modules[row][col]) continue;
            int px = qr_x0 + col * module_size;
            int py = qr_y0 + row * module_size;
            fill_rect(panel, px, py, px + module_size, py + module_size, COLOR_BLACK);
        }
    }

    ESP_LOGI(TAG, "QR drawn: %d modules at %d px/module", QR_SIZE, module_size);
}
