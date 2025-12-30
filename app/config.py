"""
Конфигурация приложения Gemini Tunnel.

Загружает настройки из переменных окружения.
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """
    Настройки приложения.
    
    Attributes:
        gemini_api_key: API ключ Google Gemini (fallback если не передан в запросе)
        gemini_base_url: Базовый URL Google Gemini API
        log_level: Уровень логирования (DEBUG, INFO, WARNING, ERROR)
        host: Хост для запуска сервера
        port: Порт для запуска сервера
    """
    
    gemini_api_key: Optional[str] = None
    gemini_base_url: str = "https://generativelanguage.googleapis.com"
    log_level: str = "INFO"
    host: str = "0.0.0.0"
    port: int = 8000
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
