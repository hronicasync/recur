import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Subscription } from '@/store/subscriptions';

export interface SubscriptionFormValues {
  name: string;
  amount: string;
  currency: string;
  period: 'monthly' | 'yearly';
  nextDue: string;
}

interface SubscriptionFormProps {
  defaultValues?: Subscription;
  onSubmit: (values: SubscriptionFormValues) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
  className?: string;
}

export function SubscriptionForm({ defaultValues, onSubmit, onCancel, submitLabel = 'Сохранить', className }: SubscriptionFormProps) {
  const [values, setValues] = useState<SubscriptionFormValues>({
    name: defaultValues?.name ?? '',
    amount: defaultValues ? String(defaultValues.amount) : '',
    currency: defaultValues?.currency ?? 'RUB',
    period: defaultValues?.period ?? 'monthly',
    nextDue: defaultValues?.nextDue ?? new Date().toISOString().slice(0, 10),
  });
  const [isSubmitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit(values);
    setSubmitting(false);
  };

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-4', className)}>
      <div className="grid gap-2">
        <Label htmlFor="name">Название</Label>
        <Input
          id="name"
          placeholder="Например, Netflix"
          value={values.name}
          onChange={(event) => setValues((prev) => ({ ...prev, name: event.target.value }))}
          required
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="amount">Стоимость</Label>
        <Input
          id="amount"
          type="number"
          min="0"
          step="0.01"
          placeholder="599"
          value={values.amount}
          onChange={(event) => setValues((prev) => ({ ...prev, amount: event.target.value }))}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label>Валюта</Label>
          <Select
            value={values.currency}
            onValueChange={(value) => setValues((prev) => ({ ...prev, currency: value }))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Выбери валюту" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="RUB">RUB</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="EUR">EUR</SelectItem>
              <SelectItem value="KZT">KZT</SelectItem>
              <SelectItem value="BYN">BYN</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Периодичность</Label>
          <Select
            value={values.period}
            onValueChange={(value: 'monthly' | 'yearly') => setValues((prev) => ({ ...prev, period: value }))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Ежемесячно</SelectItem>
              <SelectItem value="yearly">Ежегодно</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="nextDue">Дата следующего списания</Label>
        <Input
          id="nextDue"
          type="date"
          value={values.nextDue}
          onChange={(event) => setValues((prev) => ({ ...prev, nextDue: event.target.value }))}
          required
        />
      </div>
      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={isSubmitting} className="flex-1">
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            Отмена
          </Button>
        )}
      </div>
    </form>
  );
}
