#pragma once

#include <stdint.h>
#include "led_strip.h"

// 6x WS2812B-2020 around the board edge, GPIO3, RMT-driven (see
// custom-firmware-hal.md section 6).
led_strip_handle_t led_init(void);

// Flashes the badge's 4 corner LEDs (skips the two middle-edge ones) in the
// given creature's color, low brightness, 3 times, then off. Blocks for the
// duration of the flash sequence - call from the poll loop, not
// onEspNowRecv (same reasoning as the screen redraws in lcd.c).
void led_flash_creature(led_strip_handle_t strip, uint8_t creature);
