import { useEffect, useState } from 'react';

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    hash?: string;
  };
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  viewportHeight: number;
  viewportStableHeight: number;
  backButton: {
    onClick: (handler: () => void) => void;
    hide: () => void;
    show: () => void;
  };
  MainButton: {
    text: string;
    color: string;
    setText: (text: string) => void;
    onClick: (handler: () => void) => void;
    show: () => void;
    hide: () => void;
  };
  expand: () => void;
  ready: () => void;
}

export function useTelegramWebApp() {
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(null);

  useEffect(() => {
    if (window.Telegram?.WebApp) {
      const instance = window.Telegram.WebApp;
      instance.ready();
      instance.expand();
      setWebApp(instance);
    }
  }, []);

  return webApp;
}
