#pragma once

#include <stdbool.h>
#include <stdint.h>

// SC7A20HTR 3-axis accelerometer on the shared I2C bus (SDA=5, SCL=6,
// also used by the NFC chip at 0x26). Register-compatible with the ST
// LIS2DH12/LIS3DH map, which is what this driver targets.
//
// Brings up I2C and configures the accelerometer for continuous 100 Hz,
// +/-2g, high-resolution sampling.
bool accel_init(void);

// Reads the latest sample. Values are raw signed 16-bit output registers
// (left-justified in high-res mode, 12 significant bits) - not converted
// to g's, since callers here only need relative motion, not calibrated units.
bool accel_read(int16_t *x, int16_t *y, int16_t *z);
