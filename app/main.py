"""
Gemini Tunnel - Прозрачный прокси для Google Gemini API.

Принимает запросы и перенаправляет их на официальный API Google Gemini.
"""

import time
from typing import Any, Dict, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.config import settings
from app.logger import logger, log_request


app = FastAPI(
    title="Gemini Tunnel",
    description="Прозрачный прокси для Google Gemini API",
    version="1.0.0"
)


# HTTP клиент для запросов к Gemini API
http_client = httpx.AsyncClient(
    base_url=settings.gemini_base_url,
    timeout=120.0
)


@app.on_event("startup")
async def startup_event() -> None:
    """Логирование при запуске приложения."""
    logger.info("=" * 50)
    logger.info("Gemini Tunnel запущен")
    logger.info(f"Gemini API URL: {settings.gemini_base_url}")
    logger.info(f"API Key в env: {'Да' if settings.gemini_api_key else 'Нет'}")
    logger.info("=" * 50)


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Закрытие HTTP клиента при остановке."""
    await http_client.aclose()
    logger.info("Gemini Tunnel остановлен")


@app.get("/health")
async def health_check() -> Dict[str, str]:
    """
    Проверка работоспособности сервиса.
    
    Returns:
        Статус сервиса
    """
    return {"status": "healthy", "service": "gemini-tunnel"}


def get_api_key(request: Request) -> tuple[str, str]:
    """
    Получает API ключ из заголовка запроса или из переменных окружения.
    
    Args:
        request: Входящий запрос
        
    Returns:
        Кортеж (api_key, source) где source это 'header' или 'env'
        
    Raises:
        HTTPException: Если API ключ не найден
    """
    # Сначала проверяем заголовок
    header_key = request.headers.get("x-goog-api-key")
    if header_key:
        return header_key, "header"
    
    # Fallback на env
    if settings.gemini_api_key:
        return settings.gemini_api_key, "env"
    
    raise HTTPException(
        status_code=401,
        detail="API ключ не найден. Передайте его в заголовке x-goog-api-key или задайте GEMINI_API_KEY в env"
    )


@app.api_route(
    "/v1beta/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"]
)
async def proxy_gemini_request(
    request: Request,
    path: str
) -> Response:
    """
    Прозрачный прокси для Gemini API.
    
    Перенаправляет все запросы на /v1beta/* к официальному API Google Gemini.
    
    Args:
        request: Входящий запрос
        path: Путь после /v1beta/
        
    Returns:
        Ответ от Gemini API
    """
    start_time = time.time()
    api_key_source = "unknown"
    
    try:
        # Получаем API ключ
        api_key, api_key_source = get_api_key(request)
        
        # Формируем заголовки для Gemini API
        headers = {
            "x-goog-api-key": api_key,
            "Content-Type": request.headers.get("Content-Type", "application/json")
        }
        
        # Получаем тело запроса
        body = await request.body()
        
        # Формируем URL
        target_url = f"/v1beta/{path}"
        
        # Добавляем query параметры если есть
        if request.query_params:
            target_url += f"?{request.query_params}"
        
        logger.debug(f"Проксирование: {request.method} {target_url}")
        
        # Выполняем запрос к Gemini API
        response = await http_client.request(
            method=request.method,
            url=target_url,
            headers=headers,
            content=body
        )
        
        duration_ms = (time.time() - start_time) * 1000
        
        log_request(
            method=request.method,
            path=f"/v1beta/{path}",
            status_code=response.status_code,
            duration_ms=duration_ms,
            api_key_source=api_key_source
        )
        
        # Возвращаем ответ от Gemini API
        return Response(
            content=response.content,
            status_code=response.status_code,
            headers=dict(response.headers),
            media_type=response.headers.get("content-type")
        )
        
    except HTTPException:
        raise
        
    except httpx.TimeoutException:
        duration_ms = (time.time() - start_time) * 1000
        log_request(
            method=request.method,
            path=f"/v1beta/{path}",
            status_code=504,
            duration_ms=duration_ms,
            api_key_source=api_key_source,
            error="Timeout при запросе к Gemini API"
        )
        raise HTTPException(status_code=504, detail="Timeout при запросе к Gemini API")
        
    except httpx.RequestError as e:
        duration_ms = (time.time() - start_time) * 1000
        log_request(
            method=request.method,
            path=f"/v1beta/{path}",
            status_code=502,
            duration_ms=duration_ms,
            api_key_source=api_key_source,
            error=str(e)
        )
        raise HTTPException(status_code=502, detail=f"Ошибка при запросе к Gemini API: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True
    )
