idf_component_register(
    SRCS "main.c" "lcd.c"
    INCLUDE_DIRS "."
    REQUIRES esp_wifi esp_event nvs_flash driver esp_lcd
)
