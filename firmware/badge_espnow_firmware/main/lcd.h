#pragma once

#include "esp_lcd_panel_ops.h"

// Brings up the ST7789 (pin map from the Custom Flash HAL guide) and returns
// a ready-to-draw panel handle.
esp_lcd_panel_handle_t lcd_init(void);

// Fills the screen white and draws the embedded QR code (qr_code.h), sized
// and centered with a proper quiet-zone margin so it stays scannable.
void lcd_draw_qr(esp_lcd_panel_handle_t panel);
