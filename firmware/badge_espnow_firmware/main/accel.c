#include "accel.h"

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_log.h"

static const char *TAG = "accel";

#define PIN_I2C_SDA 5
#define PIN_I2C_SCL 6
#define I2C_PORT I2C_NUM_0
#define I2C_FREQ_HZ 400000
#define ACCEL_I2C_ADDR 0x19

// ---- LIS2DH12/LIS3DH-compatible register map ----
#define REG_WHO_AM_I 0x0F
#define REG_CTRL_REG1 0x20
#define REG_CTRL_REG4 0x23
#define REG_OUT_X_L 0x28

// ODR=100Hz (0101), LPen=0 (normal power), Zen=Yen=Xen=1.
#define CTRL_REG1_100HZ_XYZ_ON 0x57
// BDU=0, FS=+-2g (00), HR=1 (high-resolution mode).
#define CTRL_REG4_2G_HIGHRES 0x08

static esp_err_t reg_write(uint8_t reg, uint8_t val) {
    uint8_t buf[2] = { reg, val };
    return i2c_master_write_to_device(I2C_PORT, ACCEL_I2C_ADDR, buf, sizeof(buf), pdMS_TO_TICKS(100));
}

static esp_err_t reg_read(uint8_t reg, uint8_t *data, size_t len) {
    // ST-style auto-increment: set the sub-address MSB for multi-byte reads.
    uint8_t addr = (len > 1) ? (reg | 0x80) : reg;
    return i2c_master_write_read_device(I2C_PORT, ACCEL_I2C_ADDR, &addr, 1, data, len, pdMS_TO_TICKS(100));
}

bool accel_init(void) {
    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = I2C_FREQ_HZ,
    };

    esp_err_t err = i2c_param_config(I2C_PORT, &conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_param_config failed: %s", esp_err_to_name(err));
        return false;
    }
    err = i2c_driver_install(I2C_PORT, conf.mode, 0, 0, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_driver_install failed: %s", esp_err_to_name(err));
        return false;
    }

    uint8_t who_am_i = 0;
    if (reg_read(REG_WHO_AM_I, &who_am_i, 1) == ESP_OK) {
        ESP_LOGI(TAG, "WHO_AM_I = 0x%02X", who_am_i);
    } else {
        ESP_LOGW(TAG, "WHO_AM_I read failed - check wiring/address (0x%02X)", ACCEL_I2C_ADDR);
    }

    esp_err_t e1 = reg_write(REG_CTRL_REG1, CTRL_REG1_100HZ_XYZ_ON);
    esp_err_t e2 = reg_write(REG_CTRL_REG4, CTRL_REG4_2G_HIGHRES);
    if (e1 != ESP_OK || e2 != ESP_OK) {
        ESP_LOGE(TAG, "accelerometer config write failed");
        return false;
    }

    ESP_LOGI(TAG, "SC7A20HTR ready on I2C%d (SDA=%d SCL=%d, addr 0x%02X)",
             I2C_PORT, PIN_I2C_SDA, PIN_I2C_SCL, ACCEL_I2C_ADDR);
    return true;
}

bool accel_read(int16_t *x, int16_t *y, int16_t *z) {
    uint8_t raw[6];
    if (reg_read(REG_OUT_X_L, raw, sizeof(raw)) != ESP_OK) return false;
    *x = (int16_t)((raw[1] << 8) | raw[0]);
    *y = (int16_t)((raw[3] << 8) | raw[2]);
    *z = (int16_t)((raw[5] << 8) | raw[4]);
    return true;
}
