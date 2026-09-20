// ST7789 bring-up and a name-banner renderer.
//
// Pin map and init fixups (invert_color/swap_xy/mirror) are exactly as
// documented in the Custom Flash HAL guide: SPI2, MOSI=10, CLK=1, CS=2,
// DC=0, RST=4, 40 MHz, mode 0, RGB565. After swap_xy+mirror the usable
// drawing area is the same 320x240 landscape orientation the stock badge
// UI uses.

#include "lcd.h"
#include "creature_banners.h"
#include "creature_screens.h"

#include <stdbool.h>
#include <string.h>
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

// Draws one full-width band and blocks until the SPI transfer has actually
// completed, so the caller can safely overwrite s_band right after this
// returns.
static void draw_band(esp_lcd_panel_handle_t panel, int y, int rows) {
    esp_lcd_panel_draw_bitmap(panel, 0, y, LCD_H_RES, y + rows, s_band);
    xSemaphoreTake(s_flush_done, portMAX_DELAY);
}

// Same as draw_band(), but for an arbitrary sub-rectangle rather than always
// the full panel width - used by the creature screen's sprite/text panel,
// which only cover part of the 320x240 screen.
static void draw_rect_band(esp_lcd_panel_handle_t panel, int x, int y, int w, int rows) {
    esp_lcd_panel_draw_bitmap(panel, x, y, x + w, y + rows, s_band);
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

// ---- Creature screen: background + sprite + name/flavor text ----
// s_band (BAND_ROWS * LCD_H_RES = 5120 uint16_t) is reused as scratch for
// every shape below; a rect only ever needs as many rows per chunk as fit
// its own (narrower) width in that same budget, computed per call so a
// 140px-wide sprite gets more rows per SPI transfer than a 320px-wide
// background band would.
// Must match gen_creature_screens.py's TEXT_AVAILABLE_WIDTH (this minus
// 2x TEXT_PADDING).
#define TEXT_PANEL_X 160
#define TEXT_PANEL_Y 20
#define TEXT_PANEL_W 150
#define TEXT_PANEL_H 200
#define TEXT_PADDING 6
#define TEXT_LINE_GAP 4
#define TEXT_BLOCK_GAP 16
#define SPRITE_X 10
#define SPRITE_Y ((LCD_V_RES - SPRITE_HEIGHT) / 2)
#define COLOR_GRAY 0xC618

static int rows_per_chunk(int w) {
    int rows = (BAND_ROWS * LCD_H_RES) / w;
    return rows > 0 ? rows : 1;
}

// Samples the shared background at an absolute screen coordinate - used to
// fill in a sprite's transparent pixels so the character sits "on" the
// background instead of a solid box.
static uint16_t background_pixel_at(int x, int y) {
    int bytes_per_row = BG_WIDTH / 2;
    uint8_t byte = background_image.pixels[y * bytes_per_row + x / 2];
    uint8_t nibble = (x % 2 == 0) ? (byte >> 4) : (byte & 0x0F);
    return background_image.palette[nibble];
}

static void draw_indexed_rect(esp_lcd_panel_handle_t panel, int x, int y, int w, int h,
                               const uint16_t *palette, const uint8_t *pixels) {
    int bytes_per_row = w / 2;
    int chunk = rows_per_chunk(w);
    for (int y0 = 0; y0 < h; y0 += chunk) {
        int rows = h - y0;
        if (rows > chunk) rows = chunk;
        for (int row = 0; row < rows; row++) {
            const uint8_t *row_bytes = &pixels[(y0 + row) * bytes_per_row];
            uint16_t *row_pixels = &s_band[row * w];
            for (int col = 0; col < w; col++) {
                uint8_t byte = row_bytes[col / 2];
                uint8_t nibble = (col % 2 == 0) ? (byte >> 4) : (byte & 0x0F);
                row_pixels[col] = palette[nibble];
            }
        }
        draw_rect_band(panel, x, y + y0, w, rows);
    }
}

// Same as draw_indexed_rect(), but palette index 0 is "transparent" - drawn
// as whatever the shared background already shows through at that point,
// rather than a real color.
static void draw_sprite(esp_lcd_panel_handle_t panel, int x, int y, const indexed_image_t *sprite) {
    int bytes_per_row = SPRITE_WIDTH / 2;
    int chunk = rows_per_chunk(SPRITE_WIDTH);
    for (int y0 = 0; y0 < SPRITE_HEIGHT; y0 += chunk) {
        int rows = SPRITE_HEIGHT - y0;
        if (rows > chunk) rows = chunk;
        for (int row = 0; row < rows; row++) {
            const uint8_t *row_bytes = &sprite->pixels[(y0 + row) * bytes_per_row];
            uint16_t *row_pixels = &s_band[row * SPRITE_WIDTH];
            for (int col = 0; col < SPRITE_WIDTH; col++) {
                uint8_t byte = row_bytes[col / 2];
                uint8_t nibble = (col % 2 == 0) ? (byte >> 4) : (byte & 0x0F);
                row_pixels[col] = nibble == 0 ? background_pixel_at(x + col, y + y0 + row)
                                               : sprite->palette[nibble];
            }
        }
        draw_rect_band(panel, x, y + y0, SPRITE_WIDTH, rows);
    }
}

static void fill_rect(esp_lcd_panel_handle_t panel, int x, int y, int w, int h, uint16_t color) {
    int chunk = rows_per_chunk(w);
    for (int y0 = 0; y0 < h; y0 += chunk) {
        int rows = h - y0;
        if (rows > chunk) rows = chunk;
        for (int i = 0; i < rows * w; i++) {
            s_band[i] = color;
        }
        draw_rect_band(panel, x, y + y0, w, rows);
    }
}

// Draws one glyph cell in a single SPI transfer - a cell (at most 16x22
// pixels here) is tiny next to s_band's 5120-pixel budget, so no chunking
// is needed the way the bigger rects above need it.
static int draw_glyph(esp_lcd_panel_handle_t panel, int x, int y, const font_t *font, char ch,
                       uint16_t ink, uint16_t bg) {
    const char *at = strchr(font->charset, ch);
    if (!at) return 0;
    int index = (int)(at - font->charset);
    const uint8_t *bits = &font->bitmap[index * font->bytes_per_row * font->cell_height];

    for (int row = 0; row < font->cell_height; row++) {
        const uint8_t *row_bits = &bits[row * font->bytes_per_row];
        uint16_t *row_pixels = &s_band[row * font->cell_width];
        for (int col = 0; col < font->cell_width; col++) {
            bool set = (row_bits[col / 8] >> (7 - (col % 8))) & 1;
            row_pixels[col] = set ? ink : bg;
        }
    }
    draw_rect_band(panel, x, y, font->cell_width, font->cell_height);
    return font->widths[index];
}

static int glyph_width(const font_t *font, char ch) {
    const char *at = strchr(font->charset, ch);
    return at ? font->widths[at - font->charset] : 0;
}

static int measure_line_width(const font_t *font, const char *line, size_t len) {
    if (len == 0) return 0;
    int w = 0;
    for (size_t i = 0; i < len; i++) w += glyph_width(font, line[i]) + 1;
    return w - 1;
}

static int count_lines(const char *text) {
    int n = 1;
    for (const char *p = text; *p; p++) {
        if (*p == '\n') n++;
    }
    return n;
}

static int text_block_height(const font_t *font, const char *text) {
    return count_lines(text) * (font->cell_height + TEXT_LINE_GAP) - TEXT_LINE_GAP;
}

// Draws text horizontally centered within [x, x + w), '\n' moves to the next
// line. Glyphs are drawn on a solid bg color, not the photo background -
// simpler than compositing per-glyph, and keeps text legible regardless of
// what's under the sprite/background at that spot.
static void draw_text_centered(esp_lcd_panel_handle_t panel, int x, int w, int y, const char *text,
                                const font_t *font, uint16_t ink, uint16_t bg) {
    int cursor_y = y;
    const char *line_start = text;
    for (const char *p = text;; p++) {
        if (*p == '\n' || *p == '\0') {
            size_t len = p - line_start;
            int cursor_x = x + (w - measure_line_width(font, line_start, len)) / 2;
            for (size_t i = 0; i < len; i++) {
                cursor_x += draw_glyph(panel, cursor_x, cursor_y, font, line_start[i], ink, bg) + 1;
            }
            cursor_y += font->cell_height + TEXT_LINE_GAP;
            line_start = p + 1;
            if (*p == '\0') break;
        }
    }
}

void lcd_draw_creature_screen(esp_lcd_panel_handle_t panel, uint8_t creature) {
    if (creature >= 4) {
        ESP_LOGW(TAG, "ignoring out-of-range creature %u for screen draw", creature);
        return;
    }
    const creature_screen_t *screen = creature_screens[creature];
    ESP_LOGI(TAG, "drawing creature screen '%s'", screen->name);

    draw_indexed_rect(panel, 0, 0, BG_WIDTH, BG_HEIGHT, background_image.palette, background_image.pixels);
    draw_sprite(panel, SPRITE_X, SPRITE_Y, &screen->sprite);
    fill_rect(panel, TEXT_PANEL_X, TEXT_PANEL_Y, TEXT_PANEL_W, TEXT_PANEL_H, COLOR_BLACK);

    int name_h = text_block_height(&FONT_LARGE, screen->name);
    int flavor_h = text_block_height(&FONT_SMALL, screen->flavor);
    int total_h = name_h + TEXT_BLOCK_GAP + flavor_h;
    int start_y = TEXT_PANEL_Y + (TEXT_PANEL_H - total_h) / 2;
    int text_x = TEXT_PANEL_X + TEXT_PADDING;
    int text_w = TEXT_PANEL_W - 2 * TEXT_PADDING;

    draw_text_centered(panel, text_x, text_w, start_y, screen->name, &FONT_LARGE, COLOR_WHITE, COLOR_BLACK);
    draw_text_centered(panel, text_x, text_w, start_y + name_h + TEXT_BLOCK_GAP, screen->flavor, &FONT_SMALL,
                        COLOR_GRAY, COLOR_BLACK);
}
