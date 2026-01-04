# Полный гайд по деплою Recur Bot на VPS (SmartApe)

## Что мы будем делать?

1. Подключимся к VPS серверу
2. Установим все необходимое (Node.js, PostgreSQL, PM2)
3. Настроим PostgreSQL базу данных на сервере
4. Загрузим код бота на сервер
5. Настроим автозапуск бота
6. Мигрируем данные из Supabase (опционально)

---

## Шаг 0: Что тебе понадобится

- SSH доступ к твоему VPS (IP адрес, логин, пароль)
- Терминал на MacBook (встроенное приложение Terminal)
- Токен твоего Telegram бота (из .env)
- Доступ к Supabase (если будешь переносить данные)

---

## Шаг 1: Подключение к VPS через SSH

### 1.1 Открой Terminal на MacBook

Найди приложение **Terminal** (Cmd + Space → пиши "Terminal")

### 1.2 Подключись к серверу

```bash
ssh root@YOUR_SERVER_IP
```

Замени `YOUR_SERVER_IP` на IP адрес твоего VPS от SmartApe.

**Пример:**
```bash
ssh root@192.168.1.100
```

При первом подключении спросит "Are you sure...?" - пиши `yes` и Enter.

Введи пароль (пароль не будет виден при вводе - это нормально).

✅ Если подключился - увидишь приглашение вида `root@server:~#`

---

## Шаг 2: Обновление системы и установка необходимого ПО

### 2.1 Обнови систему

```bash
apt update && apt upgrade -y
```

### 2.2 Установи Node.js (версия 20.x LTS)

```bash
# Добавляем репозиторий NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# Устанавливаем Node.js
apt install -y nodejs

# Проверяем версию
node -v
npm -v
```

Должно показать что-то вроде `v20.x.x` и `10.x.x`

### 2.3 Установи PostgreSQL

```bash
# Устанавливаем PostgreSQL
apt install -y postgresql postgresql-contrib

# Проверяем статус
systemctl status postgresql
```

Должно быть `active (running)` зеленым цветом. Нажми `q` чтобы выйти.

### 2.4 Установи PM2 (менеджер процессов для Node.js)

```bash
npm install -g pm2
```

### 2.5 Установи Git (для загрузки кода)

```bash
apt install -y git
```

---

## Шаг 3: Настройка PostgreSQL

### 3.1 Создай пользователя и базу данных

```bash
# Переключись на пользователя postgres
sudo -u postgres psql
```

Теперь ты в консоли PostgreSQL (приглашение `postgres=#`)

### 3.2 Выполни SQL команды

```sql
-- Создаем пользователя (замени YOUR_PASSWORD на свой пароль)
CREATE USER recur_bot WITH PASSWORD 'YOUR_PASSWORD';

-- Создаем базу данных
CREATE DATABASE recur_bot_db;

-- Даем права пользователю
GRANT ALL PRIVILEGES ON DATABASE recur_bot_db TO recur_bot;

-- Выходим
\q
```

**Важно:** Запомни пароль, который указал вместо `YOUR_PASSWORD`!

### 3.3 Настрой доступ к PostgreSQL

Открой конфиг:
```bash
nano /etc/postgresql/*/main/pg_hba.conf
```

Найди строки в конце файла и убедись, что есть:
```
local   all             all                                     md5
host    all             all             127.0.0.1/32            md5
host    all             all             ::1/128                 md5
```

Если там `peer` вместо `md5` - замени на `md5`.

Сохрани: `Ctrl + O`, Enter, `Ctrl + X`

### 3.4 Перезапусти PostgreSQL

```bash
systemctl restart postgresql
```

### 3.5 Проверь подключение

```bash
psql -U recur_bot -d recur_bot_db -h localhost
```

Введи пароль, который создал. Если подключилось - отлично! Выйди: `\q`

---

## Шаг 4: Создание схемы базы данных

### 4.1 Создай SQL файл со схемой

```bash
nano /tmp/schema.sql
```

### 4.2 Скопируй и вставь эту схему:

```sql
-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
  user_id BIGINT PRIMARY KEY,
  tz VARCHAR(100) DEFAULT 'Europe/Moscow',
  notify_hour INT DEFAULT 16,
  default_reminders JSONB DEFAULT '["T-3", "T-1", "T0"]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Таблица подписок
CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL,
  period VARCHAR(20) NOT NULL CHECK (period IN ('monthly', 'yearly')),
  next_due DATE NOT NULL,
  reminders JSONB DEFAULT '["T-3", "T-1", "T0"]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для подписок
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_due ON subscriptions(next_due);

-- Таблица событий подписок
CREATE TABLE IF NOT EXISTS subscription_events (
  id SERIAL PRIMARY KEY,
  subscription_id INT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('paid', 'skipped')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для событий
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription_id ON subscription_events(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_events_date ON subscription_events(event_date);

-- Таблица логов напоминаний (для дедупликации)
CREATE TABLE IF NOT EXISTS reminder_log (
  reminder_key VARCHAR(255) PRIMARY KEY,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индекс для автоочистки старых записей
CREATE INDEX IF NOT EXISTS idx_reminder_log_sent_at ON reminder_log(sent_at);

-- Комментарии к таблицам
COMMENT ON TABLE users IS 'Пользователи бота';
COMMENT ON TABLE subscriptions IS 'Подписки пользователей';
COMMENT ON TABLE subscription_events IS 'История событий по подпискам (оплаты, пропуски)';
COMMENT ON TABLE reminder_log IS 'Лог отправленных напоминаний для дедупликации';
```

Сохрани: `Ctrl + O`, Enter, `Ctrl + X`

### 4.3 Примени схему к базе

```bash
psql -U recur_bot -d recur_bot_db -h localhost -f /tmp/schema.sql
```

Введи пароль. Если все прошло успешно - база готова!

---

## Шаг 5: Загрузка кода бота на сервер

### Вариант A: Через Git (если у тебя есть репозиторий)

```bash
# Создай директорию для проекта
mkdir -p /opt/recur_bot
cd /opt/recur_bot

# Клонируй репозиторий
git clone YOUR_REPO_URL .
```

### Вариант B: Вручную (если репозитория нет)

**На твоем MacBook:**

```bash
# Перейди в папку проекта
cd /Users/hanumatori/Desktop/hanumatori/vibecoding\ pojects/recur_bot

# Создай архив (исключая node_modules и .env)
tar -czf recur_bot.tar.gz \
  --exclude='node_modules' \
  --exclude='.env' \
  --exclude='webapp/node_modules' \
  --exclude='.git' \
  .

# Загрузи на сервер (замени YOUR_SERVER_IP)
scp recur_bot.tar.gz root@YOUR_SERVER_IP:/opt/
```

**На сервере:**

```bash
# Создай директорию
mkdir -p /opt/recur_bot
cd /opt/recur_bot

# Распакуй архив
tar -xzf /opt/recur_bot.tar.gz
```

---

## Шаг 6: Настройка окружения на сервере

### 6.1 Установи зависимости

```bash
cd /opt/recur_bot
npm install
```

### 6.2 Создай .env файл

```bash
nano .env
```

### 6.3 Заполни .env:

```env
BOT_TOKEN=your_telegram_bot_token_here
DATABASE_URL=postgresql://recur_bot:YOUR_PASSWORD@localhost:5432/recur_bot_db
DEFAULT_TZ=Europe/Moscow
DEFAULT_NOTIFY_HOUR=16
DEFAULT_REMINDERS=T-3,T-1,T0
ENABLE_REMINDER_SCHEDULER=true
ALLOW_SELF_SIGNED=0
```

**Важно:**
- `BOT_TOKEN` - токен твоего бота от BotFather
- `YOUR_PASSWORD` - пароль, который ты создал для пользователя `recur_bot` в PostgreSQL
- Проверь, что нет пробелов вокруг `=`

Сохрани: `Ctrl + O`, Enter, `Ctrl + X`

### 6.4 Проверь, что бот запускается

```bash
node node.js
```

Если увидел "Запустился как @your_bot_name" и "Polling запущен" - отлично!

Останови бота: `Ctrl + C`

---

## Шаг 7: Настройка автозапуска с PM2

### 7.1 Запусти бота через PM2

```bash
cd /opt/recur_bot
pm2 start node.js --name recur_bot
```

### 7.2 Настрой автозапуск при перезагрузке сервера

```bash
# Генерируем startup скрипт
pm2 startup systemd

# PM2 выдаст команду вида:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
# Скопируй её и выполни

# Сохраняем текущие процессы
pm2 save
```

### 7.3 Полезные команды PM2

```bash
# Посмотреть статус
pm2 status

# Посмотреть логи
pm2 logs recur_bot

# Перезапустить
pm2 restart recur_bot

# Остановить
pm2 stop recur_bot

# Удалить из PM2
pm2 delete recur_bot
```

---

## Шаг 8: Проверка работы

### 8.1 Проверь статус бота

```bash
pm2 status
```

Статус должен быть `online` зеленым.

### 8.2 Посмотри логи

```bash
pm2 logs recur_bot --lines 50
```

Должен увидеть:
```
Запустился как @your_bot_name
Polling запущен
Reminder scheduler started
```

### 8.3 Протестируй в Telegram

Открой бота в Telegram и отправь `/start`

Если бот отвечает - **поздравляю, все работает!** 🎉

---

## Шаг 9: Миграция данных из Supabase (опционально)

Если у тебя есть данные в Supabase и хочешь их перенести:

### 9.1 Экспорт из Supabase

**В Supabase Dashboard:**
1. Перейди в SQL Editor
2. Выполни запрос для экспорта каждой таблицы:

```sql
-- Экспорт users
COPY (SELECT * FROM users) TO STDOUT WITH CSV HEADER;

-- Экспорт subscriptions
COPY (SELECT * FROM subscriptions) TO STDOUT WITH CSV HEADER;

-- Экспорт subscription_events
COPY (SELECT * FROM subscription_events) TO STDOUT WITH CSV HEADER;
```

Сохрани результаты в файлы: `users.csv`, `subscriptions.csv`, `events.csv`

### 9.2 Загрузи файлы на сервер

**С MacBook:**

```bash
scp users.csv root@YOUR_SERVER_IP:/tmp/
scp subscriptions.csv root@YOUR_SERVER_IP:/tmp/
scp events.csv root@YOUR_SERVER_IP:/tmp/
```

### 9.3 Импорт на VPS

**На сервере:**

```bash
# Импорт users
psql -U recur_bot -d recur_bot_db -h localhost -c "\COPY users FROM '/tmp/users.csv' WITH CSV HEADER"

# Импорт subscriptions
psql -U recur_bot -d recur_bot_db -h localhost -c "\COPY subscriptions FROM '/tmp/subscriptions.csv' WITH CSV HEADER"

# Импорт events
psql -U recur_bot -d recur_bot_db -h localhost -c "\COPY subscription_events FROM '/tmp/events.csv' WITH CSV HEADER"

# Обнови sequence для автоинкремента
psql -U recur_bot -d recur_bot_db -h localhost -c "SELECT setval('subscriptions_id_seq', (SELECT MAX(id) FROM subscriptions));"
psql -U recur_bot -d recur_bot_db -h localhost -c "SELECT setval('subscription_events_id_seq', (SELECT MAX(id) FROM subscription_events));"
```

### 9.4 Перезапусти бота

```bash
pm2 restart recur_bot
```

---

## Шаг 10: Обновление бота в будущем

Когда захочешь обновить код бота:

### Вариант A: Через Git

```bash
cd /opt/recur_bot
git pull
npm install
pm2 restart recur_bot
```

### Вариант B: Вручную

**На MacBook:**
```bash
cd /Users/hanumatori/Desktop/hanumatori/vibecoding\ pojects/recur_bot
tar -czf recur_bot.tar.gz --exclude='node_modules' --exclude='.env' .
scp recur_bot.tar.gz root@YOUR_SERVER_IP:/opt/
```

**На сервере:**
```bash
cd /opt/recur_bot
pm2 stop recur_bot
tar -xzf /opt/recur_bot.tar.gz
npm install
pm2 restart recur_bot
```

---

## Шаг 11: Настройка файрвола (рекомендуется)

### 11.1 Установи UFW (Uncomplicated Firewall)

```bash
apt install -y ufw
```

### 11.2 Настрой правила

```bash
# Разрешаем SSH
ufw allow 22/tcp

# Включаем файрвол
ufw enable

# Проверяем статус
ufw status
```

PostgreSQL будет доступен только локально (127.0.0.1), что безопасно.

---

## Шаг 12: Настройка резервного копирования БД

### 12.1 Создай скрипт для бэкапа

```bash
nano /opt/backup_db.sh
```

### 12.2 Вставь содержимое:

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="$BACKUP_DIR/recur_bot_$DATE.sql"

# Создаем папку для бэкапов
mkdir -p $BACKUP_DIR

# Делаем дамп базы
pg_dump -U recur_bot -d recur_bot_db -h localhost > $BACKUP_FILE

# Сжимаем
gzip $BACKUP_FILE

# Удаляем бэкапы старше 7 дней
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

echo "Backup created: $BACKUP_FILE.gz"
```

Сохрани и сделай исполняемым:
```bash
chmod +x /opt/backup_db.sh
```

### 12.3 Настрой автоматический бэкап (каждый день в 3:00)

```bash
crontab -e
```

Выбери редактор (обычно nano - цифра 1), добавь строку:

```
0 3 * * * /opt/backup_db.sh
```

Сохрани: `Ctrl + O`, Enter, `Ctrl + X`

### 12.4 Протестируй бэкап

```bash
/opt/backup_db.sh
ls -lah /opt/backups/
```

Должен появиться файл `recur_bot_YYYY-MM-DD_HH-MM-SS.sql.gz`

---

## Troubleshooting (Решение проблем)

### Проблема: Бот не запускается

**Проверь логи:**
```bash
pm2 logs recur_bot --lines 100
```

**Частые причины:**
- Неправильный DATABASE_URL в .env
- База данных не создана или нет доступа
- Неправильный BOT_TOKEN

### Проблема: База данных не подключается

**Проверь статус PostgreSQL:**
```bash
systemctl status postgresql
```

**Проверь подключение вручную:**
```bash
psql -U recur_bot -d recur_bot_db -h localhost
```

**Проверь пароль в .env:**
Открой .env и сверь пароль с тем, что создавал.

### Проблема: PM2 не работает после перезагрузки

**Перенастрой автозапуск:**
```bash
pm2 unstartup systemd
pm2 startup systemd
# Выполни команду, которую выдаст PM2
pm2 save
```

### Проблема: Нет места на диске

**Проверь место:**
```bash
df -h
```

**Очисти старые логи:**
```bash
pm2 flush
journalctl --vacuum-time=7d
```

---

## Полезные команды для работы с сервером

### Мониторинг ресурсов
```bash
# Общая информация о системе
htop

# Место на диске
df -h

# Использование памяти
free -h

# Процессы Node.js
ps aux | grep node
```

### Работа с PostgreSQL
```bash
# Войти в базу
psql -U recur_bot -d recur_bot_db -h localhost

# Посмотреть все таблицы
\dt

# Посмотреть пользователей
SELECT * FROM users;

# Посмотреть подписки
SELECT * FROM subscriptions;

# Выйти
\q
```

### Работа с логами
```bash
# Логи бота (PM2)
pm2 logs recur_bot

# Логи PostgreSQL
tail -f /var/log/postgresql/postgresql-*-main.log

# Системные логи
journalctl -u postgresql -f
```

---

## Чеклист финальной проверки

- [ ] SSH подключение к серверу работает
- [ ] PostgreSQL установлен и запущен
- [ ] База данных создана, схема применена
- [ ] Код бота загружен на сервер
- [ ] .env файл создан с правильными данными
- [ ] `npm install` выполнен успешно
- [ ] Бот запускается через `node node.js`
- [ ] PM2 запустил бота и статус `online`
- [ ] Автозапуск PM2 настроен (`pm2 startup` + `pm2 save`)
- [ ] Бот отвечает в Telegram на команды
- [ ] Файрвол настроен (UFW)
- [ ] Резервное копирование настроено (cron)

---

## Контакты для помощи

Если что-то не получается - пиши @hanumatori

**Последнее обновление:** 2026-01-04
