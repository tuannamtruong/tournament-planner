export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export const get   = (p)      => api('GET',    p);
export const post  = (p, b)   => api('POST',   p, b);
export const patch = (p, b)   => api('PATCH',  p, b);
export const put   = (p, b)   => api('PUT',    p, b);
export const del   = (p)      => api('DELETE', p);
