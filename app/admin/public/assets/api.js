// Thrown on HTTP 409 from an optimistic-concurrency conflict: another operator
// changed the same record first. `.current` carries the server's now-current
// record so the caller can reload + notify instead of clobbering it.
export class ConflictError extends Error {
  constructor(message, current) {
    super(message);
    this.name = 'ConflictError';
    this.current = current;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
      if (parsed?.message) msg = String(parsed.message);
      else if (parsed?.error) msg = String(parsed.error);
    } catch { /* not JSON — keep raw text */ }
    if (res.status === 409) throw new ConflictError(msg, parsed?.current);
    throw new Error(msg);
  }
  return res.json();
}

export const get   = (p)      => api('GET',    p);
export const post  = (p, b)   => api('POST',   p, b);
export const patch = (p, b)   => api('PATCH',  p, b);
export const put   = (p, b)   => api('PUT',    p, b);
export const del   = (p)      => api('DELETE', p);
