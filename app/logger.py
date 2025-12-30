"""
Настройка логирования для Gemini Tunnel.
"""

import logging
import sys
from datetime import datetime
from typing import Optional

from app.config import settings


def setup_logger(name: str = "gemini_tunnel") -> logging.Logger:
    """
    Создаёт и настраивает логгер.
    
    Args:
        name: Имя логгера
        
    Returns:
        Настроенный логгер
    """
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))
    
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(logging.DEBUG)
        
        formatter = logging.Formatter(
            fmt="%(asctime)s | %(levelname)-8s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S"
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    
    return logger


logger = setup_logger()


def log_request(
    method: str,
    path: str,
    status_code: int,
    duration_ms: float,
    api_key_source: str,
    error: Optional[str] = None
) -> None:
    """
    Логирует информацию о запросе.
    
    Args:
        method: HTTP метод
        path: Путь запроса
        status_code: Код ответа
        duration_ms: Время выполнения в миллисекундах
        api_key_source: Источник API ключа (header/env)
        error: Сообщение об ошибке (если есть)
    """
    message = f"{method} {path} | Status: {status_code} | Duration: {duration_ms:.2f}ms | API Key: {api_key_source}"
    
    if error:
        message += f" | Error: {error}"
        logger.error(message)
    elif status_code >= 400:
        logger.warning(message)
    else:
        logger.info(message)
