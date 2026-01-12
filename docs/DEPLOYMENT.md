# Деплой recur_bot

## Текущая конфигурация

- **Платформа**: Docker на VPS (сервер s1445956)
- **Контейнер**: `recur_bot`
- **База данных**: PostgreSQL (внешняя, не в Docker)
- **Часовой пояс сервера**: UTC
- **Прокси**: SOCKS5 через host.docker.internal:1080

---

## Процесс деплоя

### На локальной машине (Mac)

1. **Внести изменения в код**

2. **Закоммитить и запушить**:
```bash
cd "/path/to/recur_bot"
git add .
git commit -m "Описание изменений"
git push
```

### На VPS сервере

3. **Подключиться к серверу**:
```bash
ssh root@s1445956.your-server.com
```

4. **Обновить бот**:
```bash
update-bot
```

Команда `update-bot` (вероятно) выполняет:
```bash
cd /path/to/recur_bot
git pull
docker compose down
docker compose up -d --build
docker logs recur_bot --tail 50
```

---

## Проверка после деплоя

### 1. Проверить логи запуска

```bash
docker logs recur_bot --tail 50 | grep "✅ Reminder scheduler"
```

Должна быть строка:
```
✅ Reminder scheduler started successfully (interval=...)
```

### 2. Проверить тики планировщика

```bash
docker logs recur_bot -f | grep "🔄 Tick"
```

Должны идти строки каждую минуту:
```
🔄 Tick #123: 2026-01-12T04:00:50.596Z
📊 Users: 10
```

### 3. Проверить статус контейнера

```bash
docker ps | grep recur_bot
```

Статус должен быть `Up` (healthy если есть healthcheck).

### 4. Использовать команду /checknotifications

Отправьте боту команду `/checknotifications` и проверьте:
- ✅ Статус планировщика: Запущен
- Последний тик должен быть недавним
- Ваши настройки (notify_hour, reminders)
- Список подписок

---

## Диагностика проблем

### Проблема: Напоминания не приходят

**1. Проверить что планировщик запущен:**
```bash
docker logs recur_bot --tail 100 | grep "Reminder scheduler"
```

Должны быть строки:
- `🚀 Starting reminder scheduler...`
- `✅ Reminder scheduler started successfully`

**2. Проверить тики в нужное время:**

Для пользователя с `notify_hour=10` проверить логи в 10:00-10:01 по московскому времени (07:00-07:01 UTC):
```bash
docker logs recur_bot --since "2026-01-12T07:00:00" --until "2026-01-12T07:02:00"
```

Должны быть:
- Строки `👤 User YOUR_USER_ID: local=10:00, notify=10, subs=N`
- Строки `✅ Weekly digest sent` (если понедельник)
- Строки `✅ Morning reminder sent` (если день списания)

**3. Проверить настройки пользователя в БД:**
```bash
docker exec -it recur_bot psql $DATABASE_URL -c "SELECT user_id, tz, notify_hour, default_reminders FROM users WHERE user_id = YOUR_USER_ID;"
```

**4. Проверить дедупликацию:**

Если напоминания блокируются старыми ключами:
```bash
docker exec -it recur_bot psql $DATABASE_URL -c "SELECT key, sent_at FROM reminder_log WHERE key LIKE 'YOUR_USER_ID|%' ORDER BY sent_at DESC LIMIT 10;"
```

Очистить старые ключи (если нужно):
```bash
docker exec -it recur_bot psql $DATABASE_URL -c "DELETE FROM reminder_log WHERE key LIKE 'YOUR_USER_ID|%' AND sent_at < now() - interval '1 day';"
```

**5. Использовать /checknotifications:**

Команда покажет полную диагностику системы уведомлений.

### Проблема: Бот не отвечает

**1. Проверить статус контейнера:**
```bash
docker ps -a | grep recur_bot
```

**2. Проверить логи на ошибки:**
```bash
docker logs recur_bot --tail 100
```

**3. Перезапустить контейнер:**
```bash
docker compose restart
```

### Проблема: База данных недоступна

**1. Проверить подключение к БД из контейнера:**
```bash
docker exec -it recur_bot psql $DATABASE_URL -c "SELECT now();"
```

**2. Использовать команду /dbstatus в боте**

**3. Проверить DATABASE_URL в .env:**
```bash
docker exec -it recur_bot printenv DATABASE_URL
```

### Проблема: Нет места на диске

**1. Проверить место:**
```bash
df -h
```

**2. Очистить старые логи Docker:**
```bash
docker system prune -a --volumes
```

**3. Очистить старые образы:**
```bash
docker images | grep none
docker image prune
```

---

## Мониторинг

### Логи в реальном времени

```bash
# Все логи
docker logs recur_bot -f

# Только тики планировщика
docker logs recur_bot -f | grep "🔄 Tick"

# Только успешные отправки
docker logs recur_bot -f | grep "✅"

# Только ошибки
docker logs recur_bot -f | grep "❌"
```

### Проверка ресурсов

```bash
# Использование ресурсов контейнером
docker stats recur_bot

# Использование диска
docker system df
```

### Проверка сети

```bash
# Проверить что контейнер может достучаться до Telegram API
docker exec -it recur_bot ping -c 3 api.telegram.org
```

---

## Резервное копирование

### Бэкап базы данных

```bash
# Создать бэкап
docker exec -it recur_bot pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql

# Восстановить из бэкапа
cat backup_20260112.sql | docker exec -i recur_bot psql $DATABASE_URL
```

### Бэкап .env файла

```bash
cp .env .env.backup
```

---

## Обновление зависимостей

```bash
# В локальном проекте
npm update

# Проверить устаревшие пакеты
npm outdated

# Обновить package-lock.json
npm install

# Закоммитить и задеплоить
git add package*.json
git commit -m "Update dependencies"
git push
# На сервере: update-bot
```

---

## Откат изменений

Если после деплоя что-то сломалось:

```bash
# На VPS
cd /path/to/recur_bot

# Откатить к предыдущему коммиту
git log --oneline -n 5  # Посмотреть последние коммиты
git reset --hard COMMIT_HASH

# Пересобрать и перезапустить
docker compose down
docker compose up -d --build

# Проверить логи
docker logs recur_bot --tail 50
```

---

## Полезные команды

### Docker

```bash
# Перезапустить контейнер
docker compose restart

# Остановить
docker compose down

# Запустить с пересборкой
docker compose up -d --build

# Войти в контейнер
docker exec -it recur_bot sh

# Посмотреть переменные окружения
docker exec -it recur_bot printenv
```

### Git

```bash
# Посмотреть статус
git status

# Посмотреть последние коммиты
git log --oneline -n 10

# Посмотреть изменения
git diff

# Откатить изменения в файле
git checkout -- filename
```

### База данных

```bash
# Подключиться к БД из контейнера
docker exec -it recur_bot psql $DATABASE_URL

# Посмотреть все таблицы
docker exec -it recur_bot psql $DATABASE_URL -c "\dt"

# Посмотреть количество пользователей
docker exec -it recur_bot psql $DATABASE_URL -c "SELECT COUNT(*) FROM users;"

# Посмотреть количество подписок
docker exec -it recur_bot psql $DATABASE_URL -c "SELECT COUNT(*) FROM subscriptions;"
```

---

## Настройка команды update-bot (опционально)

Если команда `update-bot` не настроена, можно создать её:

### Вариант 1: Bash alias (на сервере)

Добавить в `~/.bashrc` или `~/.zshrc`:
```bash
alias update-bot='cd /path/to/recur_bot && git pull && docker compose down && docker compose up -d --build && docker logs recur_bot --tail 50'
```

Применить:
```bash
source ~/.bashrc  # или source ~/.zshrc
```

### Вариант 2: Отдельный скрипт

Создать `/usr/local/bin/update-bot`:
```bash
#!/bin/bash
cd /path/to/recur_bot
echo "Pulling latest changes..."
git pull
echo "Rebuilding and restarting..."
docker compose down
docker compose up -d --build
echo "Latest logs:"
docker logs recur_bot --tail 50
```

Сделать исполняемым:
```bash
chmod +x /usr/local/bin/update-bot
```

---

## Контакты и поддержка

- **Автор**: @hanumatori
- **Документация**: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)
- **Гайд по VPS**: [VPS_SETUP_GUIDE.md](VPS_SETUP_GUIDE.md)
