import { proxy, useSnapshot } from 'valtio';

export interface Subscription {
  id: string;
  name: string;
  amount: number;
  currency: string;
  period: 'monthly' | 'yearly';
  nextDue: string;
}

interface SubscriptionState {
  items: Subscription[];
  isLoading: boolean;
}

const initialData: Subscription[] = [
  {
    id: 'demo-1',
    name: 't-mobile',
    amount: 482,
    currency: 'RUB',
    period: 'monthly',
    nextDue: '2025-10-24',
  },
  {
    id: 'demo-2',
    name: 'lagom vpn',
    amount: 299,
    currency: 'RUB',
    period: 'monthly',
    nextDue: '2025-10-25',
  },
];

export const subscriptionState = proxy<SubscriptionState>({
  items: initialData,
  isLoading: false,
});

export const useSubscriptions = () => useSnapshot(subscriptionState);

export function setSubscriptions(subscriptions: Subscription[]) {
  subscriptionState.items = subscriptions;
}

export function upsertSubscription(subscription: Subscription) {
  const index = subscriptionState.items.findIndex((item) => item.id === subscription.id);
  if (index >= 0) {
    subscriptionState.items[index] = subscription;
  } else {
    subscriptionState.items = [subscription, ...subscriptionState.items];
  }
}

export function removeSubscription(id: string) {
  subscriptionState.items = subscriptionState.items.filter((item) => item.id !== id);
}

export function setLoading(value: boolean) {
  subscriptionState.isLoading = value;
}
