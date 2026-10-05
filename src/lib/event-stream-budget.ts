export function createEventStreamBudget(totalLimit = 200, userLimit = 6) {
  let total = 0;
  const users = new Map<string, number>();
  return (userId: string) => {
    if (total >= totalLimit || (users.get(userId) ?? 0) >= userLimit) return null;
    total++; users.set(userId, (users.get(userId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; total--;
      const remaining = (users.get(userId) ?? 1) - 1;
      if (remaining) users.set(userId, remaining); else users.delete(userId);
    };
  };
}
