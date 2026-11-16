import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  LAVAGEM_TAB_SLOW_THRESHOLD_MS,
  evaluateTabRenderPerformance,
  getLavagemTabLabel,
  shouldWarnOnSlowTabRender,
} from '../src/lib/lavagemTabPerformance';
import { shouldRegisterServiceWorker } from '../src/lib/serviceWorkerRegistration';

const ROOT = path.resolve(import.meta.dirname, '..');

test('src/sw.js is valid JavaScript and caches /logo.png + static assets while skipping API and Vite dev modules', () => {
  const swSource = fs.readFileSync(path.join(ROOT, 'src/sw.js'), 'utf8');
  assert.match(swSource, /bp-static-assets-v1/);
  assert.match(swSource, /\/logo\.png/);
  assert.match(swSource, /skipWaiting/);
  assert.match(swSource, /clients\.claim/);
  assert.match(swSource, /supabase\\\.co/);
  assert.match(swSource, /@vite/);

  // Verify syntactic validity and install/activate/fetch handler registration in a lightweight sandbox
  const listeners: Record<string, Function[]> = {};
  const sandbox = {
    URL,
    Request: class MockRequest {
      url: string;
      constructor(url: string) {
        this.url = url;
      }
    },
    self: {
      location: { origin: 'https://app.example.com' },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
      addEventListener(type: string, fn: Function) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
    },
    caches: {
      open: async () => ({
        add: async () => undefined,
        match: async () => undefined,
        put: async () => undefined,
      }),
      keys: async () => [],
      delete: async () => true,
    },
  };
  vm.runInNewContext(swSource, sandbox);
  assert.equal(listeners.install?.length, 1);
  assert.equal(listeners.activate?.length, 1);
  assert.equal(listeners.fetch?.length, 1);
});

test('main.tsx invokes registerAppServiceWorker and vite.config.ts syncs src/sw.js', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf8');
  const viteCfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
  assert.match(mainSrc, /registerAppServiceWorker\(\)/);
  assert.match(viteCfg, /syncServiceWorker/);
  assert.match(viteCfg, /src\/sw\.js/);
  assert.match(viteCfg, /\/sw\.js/);
});

test('shouldRegisterServiceWorker allows https and localhost only when serviceWorker exists', () => {
  assert.equal(
    shouldRegisterServiceWorker({ hasServiceWorker: true, protocol: 'https:', hostname: 'app.brancoperes.com' }),
    true
  );
  assert.equal(
    shouldRegisterServiceWorker({ hasServiceWorker: true, protocol: 'http:', hostname: 'localhost' }),
    true
  );
  assert.equal(
    shouldRegisterServiceWorker({ hasServiceWorker: true, protocol: 'http:', hostname: '127.0.0.1' }),
    true
  );
  assert.equal(
    shouldRegisterServiceWorker({ hasServiceWorker: true, protocol: 'http:', hostname: 'insecure.example.com' }),
    false
  );
  assert.equal(
    shouldRegisterServiceWorker({ hasServiceWorker: false, protocol: 'https:', hostname: 'app.brancoperes.com' }),
    false
  );
});

test('evaluateTabRenderPerformance flags >300ms transitions with friendly label and stays quiet <=300ms', () => {
  assert.equal(LAVAGEM_TAB_SLOW_THRESHOLD_MS, 300);
  assert.equal(getLavagemTabLabel('programacoes'), 'Programações');
  assert.equal(getLavagemTabLabel('dashboard'), 'Dashboard');
  assert.equal(getLavagemTabLabel('importar'), 'Importar');
  assert.equal(getLavagemTabLabel('exportar'), 'Exportar');

  const fast = evaluateTabRenderPerformance({ tab: 'dashboard', elapsedMs: 142 });
  assert.equal(fast.isSlow, false);
  assert.equal(fast.warningMessage, null);

  const boundary = evaluateTabRenderPerformance({ tab: 'importar', elapsedMs: 300 });
  assert.equal(boundary.isSlow, false);
  assert.equal(boundary.warningMessage, null);

  const slow = evaluateTabRenderPerformance({ tab: 'dashboard', elapsedMs: 342.4 });
  assert.equal(slow.isSlow, true);
  assert.equal(slow.elapsedMs, 342);
  assert.equal(slow.label, 'Dashboard');
  assert.match(slow.warningMessage ?? '', /Dashboard.*342 ms.*300 ms/);
});

test('shouldWarnOnSlowTabRender suppresses duplicate warnings for the same tab within cooldown', () => {
  assert.equal(
    shouldWarnOnSlowTabRender({
      isSlow: false,
      tab: 'dashboard',
      lastWarnedTab: null,
      lastWarnedAt: 0,
      now: 1000,
    }),
    false
  );

  assert.equal(
    shouldWarnOnSlowTabRender({
      isSlow: true,
      tab: 'dashboard',
      lastWarnedTab: 'dashboard',
      lastWarnedAt: 1000,
      now: 2500,
      cooldownMs: 4000,
    }),
    false
  );

  assert.equal(
    shouldWarnOnSlowTabRender({
      isSlow: true,
      tab: 'importar',
      lastWarnedTab: 'dashboard',
      lastWarnedAt: 1000,
      now: 2500,
      cooldownMs: 4000,
    }),
    true
  );

  assert.equal(
    shouldWarnOnSlowTabRender({
      isSlow: true,
      tab: 'dashboard',
      lastWarnedTab: 'dashboard',
      lastWarnedAt: 1000,
      now: 5500,
      cooldownMs: 4000,
    }),
    true
  );
});

test('LavagemPremiumLayout wires useLavagemTabPerformance and Layout preserves mount across Lavagem tabs', () => {
  const layoutSrc = fs.readFileSync(path.join(ROOT, 'src/components/LavagemPremiumLayout.tsx'), 'utf8');
  const shellLayoutSrc = fs.readFileSync(path.join(ROOT, 'src/components/Layout.tsx'), 'utf8');
  const lavagemCss = fs.readFileSync(path.join(ROOT, 'src/styles/lavagem-premium.css'), 'utf8');
  assert.match(layoutSrc, /useLavagemTabPerformance/);
  assert.match(layoutSrc, /lavagem-perf-soft-warning/);
  assert.match(layoutSrc, /role="status"/);
  assert.match(layoutSrc, /data-tab-render-ms/);
  assert.match(shellLayoutSrc, /lavagem-premium-module/);
  assert.match(lavagemCss, /contain:\s*layout style/);
  assert.match(lavagemCss, /will-change:\s*opacity,\s*transform/);
});
