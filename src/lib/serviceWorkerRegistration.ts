export interface ServiceWorkerEnvLike {
  hasServiceWorker: boolean;
  protocol: string;
  hostname: string;
}

export function shouldRegisterServiceWorker(env: ServiceWorkerEnvLike): boolean {
  if (!env.hasServiceWorker) return false;
  if (env.protocol === 'https:') return true;
  return (
    env.protocol === 'http:' &&
    (env.hostname === 'localhost' || env.hostname === '127.0.0.1' || env.hostname === '[::1]')
  );
}

export function registerAppServiceWorker(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

  const allowed = shouldRegisterServiceWorker({
    hasServiceWorker: 'serviceWorker' in navigator,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
  });

  if (!allowed) return;

  const startRegistration = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((error) => {
        console.warn('[sw] Registro do cache offline indisponível neste ambiente:', error);
      });
  };

  if (document.readyState === 'complete') {
    startRegistration();
    return;
  }

  window.addEventListener('load', startRegistration, { once: true });
}
