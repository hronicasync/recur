import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useTelegramWebApp } from '@/hooks/useTelegramWebApp';
import {
  Subscription,
  SubscriptionFormValues,
  removeSubscription,
  setLoading,
  upsertSubscription,
  useSubscriptions,
} from '@/store/subscriptions';
import { SubscriptionForm } from '@/components/subscription-form';
import { format } from '@/utils/format';
import { Toaster, toast } from 'sonner';

function createMockId() {
  return `temp-${Math.random().toString(36).slice(2, 8)}`;
}

function App() {
  const telegram = useTelegramWebApp();
  const { items, isLoading } = useSubscriptions();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : a.name.localeCompare(b.name)));
  }, [items]);

  const handleSubmit = async (values: SubscriptionFormValues) => {
    setLoading(true);
    try {
      const payload: Subscription = {
        id: editing?.id ?? createMockId(),
        name: values.name.trim(),
        amount: Number(values.amount),
        currency: values.currency,
        period: values.period,
        nextDue: values.nextDue,
      };

      // TODO: call API
      upsertSubscription(payload);
      toast.success(editing ? 'Подписка обновлена' : 'Подписка добавлена');
      setEditing(null);
      setOpen(false);
    } catch (error) {
      console.error(error);
      toast.error('Не удалось сохранить подписку');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = (id: string) => {
    removeSubscription(id);
    toast.info('Подписка удалена локально');
    // TODO: send delete request
  };

  return (
    <div className="min-h-screen bg-background px-4 pb-10 pt-6 text-foreground">
      <Toaster richColors position="top-center" />
      <header className="mb-6 flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Мои подписки</h1>
        <p className="text-sm text-muted-foreground">
          {telegram?.initDataUnsafe?.user
            ? `Привет, ${telegram.initDataUnsafe.user.first_name ?? telegram.initDataUnsafe.user.username}`
            : 'Тестовый режим mini-app'}
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Dialog open={open} onOpenChange={(value) => {
          setOpen(value);
          if (!value) setEditing(null);
        }}>
          <DialogTrigger asChild>
            <Button>Добавить подписку</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editing ? 'Редактирование' : 'Новая подписка'}</DialogTitle>
            </DialogHeader>
            <SubscriptionForm
              defaultValues={editing ?? undefined}
              onSubmit={handleSubmit}
              onCancel={() => {
                setOpen(false);
                setEditing(null);
              }}
              submitLabel={editing ? 'Сохранить' : 'Добавить'}
            />
          </DialogContent>
        </Dialog>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {isLoading ? 'сохраняем изменения…' : `${sorted.length} подписок`}
        </span>
      </div>

      <section className="grid gap-4">
        {sorted.map((subscription) => (
          <Card key={subscription.id} className="border-border/40 bg-card/80 backdrop-blur">
            <CardHeader className="pb-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg capitalize">{subscription.name}</CardTitle>
                  <CardDescription className="mt-1 text-sm text-muted-foreground">
                    {subscription.period === 'monthly' ? 'Ежемесячно' : 'Ежегодно'} • {subscription.currency}
                  </CardDescription>
                </div>
                <div className="text-right text-lg font-semibold text-primary">
                  {format.currency(subscription.amount, subscription.currency)}
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-0">
              <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-4 py-3 text-sm">
                <span className="text-muted-foreground">Следующее списание</span>
                <span className="font-medium">{format.date(subscription.nextDue)}</span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    setEditing(subscription);
                    setOpen(true);
                  }}
                >
                  Редактировать
                </Button>
                <Button
                  variant="ghost"
                  className="flex-1 border border-border/50"
                  onClick={() => handleDelete(subscription.id)}
                >
                  Удалить
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        {!sorted.length && (
          <Card className="border-dashed border-border/50 bg-card/60">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Подписок пока нет. Нажми «Добавить подписку», чтобы начать.
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

export default App;
