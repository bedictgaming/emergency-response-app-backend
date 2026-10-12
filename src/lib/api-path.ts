// Match Express's case-insensitive /api mount, including the bare mount and
// trailing slash. Classify only: never decode, lowercase or rewrite signed URLs.
export function isApiPath(pathname: string): boolean {
  return /^\/api(?:\/|$)/i.test(pathname);
}
