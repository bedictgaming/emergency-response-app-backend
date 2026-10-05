import { expect, it } from 'vitest';
import { createEventStreamBudget } from '@/lib/event-stream-budget';
it('bounds per-user and total connections; release is idempotent', () => {
  const acquire = createEventStreamBudget(3, 2);
  const first = acquire('a')!, second = acquire('a')!;
  expect(acquire('a')).toBeNull(); const third = acquire('b')!;
  expect(acquire('c')).toBeNull(); first(); first();
  const fourth = acquire('c')!; expect(fourth).toBeTypeOf('function'); expect(acquire('d')).toBeNull();
  second(); third(); fourth(); expect(acquire('d')).toBeTypeOf('function');
});
