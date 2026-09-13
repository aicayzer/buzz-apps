/** Redirected resources must not inherit the original repository's publication approval. */
export function belongsToRepository(
  target: string,
  resource: unknown,
): boolean {
  if (!resource || typeof resource !== 'object') return false;
  const value = resource as Record<string, unknown>;
  const expected = target.toLowerCase();
  if (
    typeof value.full_name === 'string' &&
    value.full_name.toLowerCase() !== expected
  )
    return false;
  const urls = [value.html_url, value.repository_url, value.url].filter(
    (url): url is string => typeof url === 'string',
  );
  if (!urls.length) return false;
  return urls.every((raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password)
        return false;
      const parts = url.pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
      if (url.hostname === 'api.github.com') {
        if (parts.shift() !== 'repos') return false;
      } else if (url.hostname !== 'github.com') return false;
      return parts.slice(0, 2).join('/').toLowerCase() === expected;
    } catch {
      return false;
    }
  });
}
