# Запуск на сервере

Архив подготовлен для запуска текущей версии приложения. Файл `.env` включен в архив и содержит рабочие настройки и ключи.

## Требования

- Node.js 20 или новее
- PostgreSQL, если `POSTGRES_ENABLED=true`
- ffmpeg в `PATH`
- Python с установленным пакетом `gigaam`
- SMTP-доступ для email-отчётов, если включена отправка отчётов

## Быстрый старт

```bash
npm ci
python -m pip install gigaam
npm start
```

По умолчанию приложение слушает порт из `.env` (`PORT`). После запуска откройте:

```text
http://SERVER_IP:PORT/
```

Для расписаний действий задайте локальный часовой пояс и интервал проверки:

```env
TZ=Asia/Yekaterinburg
ACTION_SCHEDULER_INTERVAL_SECONDS=30
```

Действия в режимах `daily` и `weekly` запускаются сервером после окончания выбранного периода группы. Дневные отчёты отправляются отдельно для каждого дня. Недельный отчёт охватывает понедельник–пятницу и отправляется после 18:00 пятницы (либо после окончания ночного пятничного интервала); суббота используется как окно догоняющей отправки. Обработку дневных записей по субботам и воскресеньям можно включить отдельной галочкой в действии.

## PostgreSQL

Приложение подключается к PostgreSQL по настройкам `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` из `.env`.
При старте сервер сам создает базу `PGDATABASE`, если у пользователя есть права, и инициализирует нужные таблицы.

## Email-отчёты

Получатели задаются в настройках приложения. Отчёт прикрепляется к письму как `.docx` с дневными метками, вопросом, ответом ChatGPT и обработанными камерами. Для отправки писем заполните в `.env`:

```env
REPORT_SMTP_HOST=smtp.yandex.ru
REPORT_SMTP_PORT=465
REPORT_SMTP_SECURE=true
REPORT_SMTP_STARTTLS=false
REPORT_SMTP_TIMEOUT_MS=30000
REPORT_SMTP_RETRIES=2
REPORT_SMTP_RETRY_DELAY_MS=1500
REPORT_SMTP_FALLBACK_587=true
REPORT_SMTP_USER=mailbox@yandex.ru
REPORT_SMTP_PASSWORD=app-password
REPORT_SMTP_FROM=mailbox@yandex.ru
```

## Проверка

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/storage
```

`/api/health` должен вернуть `ok: true`, а `/api/storage` должен вернуть данные из PostgreSQL.
