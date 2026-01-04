import 'dotenv/config';
import { Bot } from 'grammy';
import { startReminderScheduler } from './reminderScheduler.js';

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error('BOT_TOKEN is missing. Add it to your environment variables.');
  process.exit(1);
}

const bot = new Bot(token);

let intervalHandle;

startReminderScheduler(bot)
  .then((handle) => {
    intervalHandle = handle;
    console.log('Reminder worker started. Press Ctrl+C to exit.');
  })
  .catch((err) => {
    console.error('Failed to start reminder worker', err);
    process.exit(1);
  });

const cleanShutdown = () => {
  console.log('Stopping reminder worker...');
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
  process.exit(0);
};

process.on('SIGINT', cleanShutdown);
process.on('SIGTERM', cleanShutdown);
