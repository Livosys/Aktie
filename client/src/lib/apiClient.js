let csrfTokenGetter = () => null;
let unauthorizedHandler = null;

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = details.status || 0;
    this.code = details.code || null;
    this.body = details.body || null;
    this.authRequired = details.authRequired === true;
  }
}

function isMutation(method) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function isSameOriginApi(input) {
  const raw = typeof input === 'string' ? input : input?.url;
  if (!raw) return false;
  try {
    const url = new URL(raw, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch (_) {
    return false;
  }
}

function methodOf(input, options = {}) {
  return String(options.method || input?.method || 'GET').toUpperCase();
}

function friendlyMessage(status, body, fallback = '') {
  if (status === 401) return 'Sessionen har gått ut. Logga in igen.';
  if (status === 403) return 'Du saknar behörighet för denna åtgärd.';
  if (status === 409) return 'Strategin kunde inte ändras på grund av aktuell state.';
  if (status === 422 || status === 400) return body?.message || body?.error || 'Ogiltig strategi eller begäran.';
  if (status >= 500) return 'Servern kunde inte ändra strategin.';
  return body?.message || body?.error || body?.reason || fallback || `HTTP ${status}`;
}

async function parseBody(response) {
  const contentType = String(response.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => '');
  return text ? { error: text } : null;
}

function buildHeaders(input, options = {}) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  const optionHeaders = new Headers(options.headers || {});
  optionHeaders.forEach((value, key) => headers.set(key, value));
  const method = methodOf(input, options);
  if (isSameOriginApi(input) && isMutation(method) && !headers.has('X-CSRF-Token')) {
    const token = csrfTokenGetter?.();
    if (token) headers.set('X-CSRF-Token', token);
  }
  return headers;
}

export function configureApiClient({ getCsrfToken, onUnauthorized } = {}) {
  csrfTokenGetter = typeof getCsrfToken === 'function' ? getCsrfToken : () => null;
  unauthorizedHandler = typeof onUnauthorized === 'function' ? onUnauthorized : null;
}

export async function apiFetch(input, options = {}) {
  const method = methodOf(input, options);
  const headers = buildHeaders(input, options);
  const requestOptions = {
    ...options,
    method,
    headers,
    credentials: options.credentials || 'include',
  };
  let response;
  try {
    response = await fetch(input, requestOptions);
  } catch (err) {
    throw new ApiError('Kunde inte ansluta till servern.', { code: 'network_error', body: { cause: err?.message || String(err) } });
  }
  const body = await parseBody(response);
  if (response.status === 401 && unauthorizedHandler) unauthorizedHandler();
  if (!response.ok) {
    throw new ApiError(friendlyMessage(response.status, body), {
      status: response.status,
      code: body?.error || body?.reason || null,
      body,
      authRequired: response.status === 401,
    });
  }
  return body;
}

export function installAuthenticatedFetch({ getCsrfToken, onUnauthorized } = {}) {
  configureApiClient({ getCsrfToken, onUnauthorized });
  if (typeof window === 'undefined' || window.__tradingOsFetchInstalled) {
    return () => {};
  }
  const originalFetch = window.fetch.bind(window);
  window.__tradingOsFetchInstalled = true;
  window.fetch = async (input, options = {}) => {
    const method = methodOf(input, options);
    const sameOriginApi = isSameOriginApi(input);
    const nextOptions = sameOriginApi ? {
      ...options,
      credentials: options.credentials || 'include',
      headers: buildHeaders(input, options),
    } : options;
    let response;
    try {
      response = await originalFetch(input, nextOptions);
    } catch (err) {
      throw err;
    }
    if (sameOriginApi && response.status === 401 && unauthorizedHandler) {
      unauthorizedHandler();
    }
    return response;
  };
  return () => {
    window.fetch = originalFetch;
    window.__tradingOsFetchInstalled = false;
  };
}

export const apiClientInternals = {
  isMutation,
  isSameOriginApi,
  friendlyMessage,
};
