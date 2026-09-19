#pragma once

#include "esp_lcd_panel_ops.h"

// Brings up the ST7789 (pin map from the Custom Flash HAL guide) and returns
// a ready-to-draw panel handle.
esp_lcd_panel_handle_t lcd_init(void);

// Draws the embedded 320x240 badge image (badge_image.h) full-screen.
void lcd_draw_image(esp_lcd_panel_handle_t panel);
