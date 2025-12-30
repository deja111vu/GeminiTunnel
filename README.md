<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?style=for-the-badge&logo=python&logoColor=white" alt="Python"/>
  <img src="https://img.shields.io/badge/FastAPI-0.115+-green?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/Docker-Ready-blue?style=for-the-badge&logo=docker&logoColor=white" alt="Docker"/>
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License"/>
</p>

# 🚀 Gemini Tunnel

Прозрачный прокси-сервис для **Google Gemini API**. Разверните на VPS в стране с доступом к Gemini API и перенаправляйте запросы из любой точки мира.

## ✨ Возможности

- 🔄 **Прозрачное проксирование** — запросы передаются на Gemini API без изменений
- 🔑 **Гибкая авторизация** — API ключ из заголовка или переменных окружения
- 📝 **Логирование** — все запросы логируются с метриками производительности
- 🐳 **Docker-ready** — разворачивается одной командой
- ⚡ **Асинхронный** — построен на FastAPI + httpx

## 📦 Быстрый старт

### Требования

- Docker & Docker Compose
- API ключ Google Gemini 

### Установка

```bash
# Клонирование
git clone https://github.com/deja111vu/GeminiTunnel.git
cd GeminiTunnel

# Настройка
cp .env.example .env
nano .env  # Добавьте ваш GEMINI_API_KEY

# Запуск
docker-compose up -d
```

### Проверка

```bash
curl http://localhost:8000/health
# {"status":"healthy","service":"gemini-tunnel"}
```

## 🔧 Использование

### Базовый запрос

```bash
curl -X POST "http://YOUR_VPS_IP:8000/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "Привет, Gemini!"}]}]
  }'
```

### С передачей своего API ключа

```bash
curl -X POST "http://YOUR_VPS_IP:8000/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: YOUR_API_KEY" \
  -d '{
    "contents": [{"parts": [{"text": "Hello!"}]}]
  }'
```

## 🐍 Интеграция с Python

```python
import httpx

PROXY_URL = "http://YOUR_VPS_IP:8000"

async def generate(prompt: str, api_key: str = None) -> dict:
    """
    Отправляет запрос через Gemini Tunnel.
    
    Args:
        prompt: Текст запроса
        api_key: API ключ (опционально, если настроен на сервере)
    
    Returns:
        Ответ от Gemini API
    """
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["x-goog-api-key"] = api_key
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{PROXY_URL}/v1beta/models/gemini-1.5-flash:generateContent",
            headers=headers,
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=120.0
        )
        return response.json()
```

## ⚙️ Конфигурация

| Переменная | Описание | По умолчанию |
|------------|----------|--------------|
| `GEMINI_API_KEY` | API ключ Google Gemini | — |
| `LOG_LEVEL` | Уровень логирования | `INFO` |

## 🔐 Безопасность

Рекомендуется ограничить доступ к сервису:

### UFW (Ubuntu/Debian)

```bash
# Разрешить только с определённых IP
sudo ufw allow from YOUR_CLIENT_IP to any port 8000

# Заблокировать остальные
sudo ufw deny 8000
```

### iptables

```bash
iptables -A INPUT -p tcp --dport 8000 -s YOUR_CLIENT_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 8000 -j DROP
```

## 📊 Мониторинг

```bash
# Логи в реальном времени
docker-compose logs -f

# Пример вывода
# 2024-12-30 20:45:12 | INFO     | POST /v1beta/models/gemini-2.5-flash:generateContent | Status: 200 | Duration: 1523.45ms | API Key: env
```

## 📁 Структура проекта

```
GeminiTunnel/
├── app/
│   ├── __init__.py
│   ├── config.py      # Конфигурация
│   ├── logger.py      # Логирование  
│   └── main.py        # FastAPI приложение
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── .env.example
└── README.md
```

## 🤝 Contributing

Pull requests приветствуются!

## 📄 Лицензия

[MIT](LICENSE)

---
