-- Добавление поля emoji к таблице subscriptions
-- Дефолтное значение: ▫️

ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS emoji VARCHAR(10) DEFAULT '▫️';

-- Обновляем все существующие подписки дефолтным эмодзи
UPDATE subscriptions
SET emoji = '▫️'
WHERE emoji IS NULL;

-- Комментарий
COMMENT ON COLUMN subscriptions.emoji IS 'Эмодзи для отображения подписки (по умолчанию ▫️)';
