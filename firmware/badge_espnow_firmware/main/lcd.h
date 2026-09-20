#pragma once

#include <stdint.h>
#include "esp_lcd_panel_ops.h"

// Brings up the ST7789 (pin map from the Custom Flash HAL guide) and returns
// a ready-to-draw panel handle.
esp_lcd_panel_handle_t lcd_init(void);

// Draws a CREATURE_BANNER_WIDTH x CREATURE_BANNER_HEIGHT 1bpp mask (see
// creature_banners.h - a creature_banners[] entry, or one of the
// system_*_banner screens) centered on an otherwise blank screen. label is
// only for the log line (e.g. "bingbong", "press-to-join", "goose"), so
// redraws are visible on serial without staring at the physical screen.
void lcd_draw_banner(esp_lcd_panel_handle_t panel, const uint8_t *banner, const char *label);

// Draws the full creature screen: shared background, the creature's sprite
// on the left, its slot name and flavor text on the right (see
// creature_screens.h / gen_creature_screens.py).
void lcd_draw_creature_screen(esp_lcd_panel_handle_t panel, uint8_t creature);
