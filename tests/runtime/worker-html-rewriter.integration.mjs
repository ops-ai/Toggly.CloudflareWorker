import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { unstable_dev } from 'wrangler';

function startFixtureOrigin() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture-origin.test');

    if (url.pathname === '/toggly-page-features.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }

    if (url.pathname === '/evaluated-signed/edge-test/Production') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ defs: { DisabledFeature: false, EnabledFeature: true } }));
      return;
    }

    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
        <main>
          <section id="disabled" data-feature="DisabledFeature">Disabled content</section>
          <section id="enabled" data-feature="EnabledFeature">Enabled content</section>
        </main>`);
      return;
    }

    response.writeHead(404);
    response.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture origin did not provide a TCP address.'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopWorkerAndCloseOrigin(worker, server) {
  const errors = [];

  try {
    await worker?.stop();
  } catch (error) {
    errors.push(error);
  }

  try {
    await closeServer(server);
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Worker and fixture origin shutdown failed');
  }
}

test('fixture origin closes when Worker shutdown rejects', async () => {
  const { server } = await startFixtureOrigin();
  const stopError = new Error('Worker shutdown failed');

  await assert.rejects(
    stopWorkerAndCloseOrigin({ stop: async () => { throw stopError; } }, server),
    (error) => error === stopError,
  );
  assert.equal(server.listening, false);
});

test('cleanup reports both Worker and origin shutdown failures', async () => {
  const { server } = await startFixtureOrigin();
  await closeServer(server);
  const stopError = new Error('Worker shutdown failed');

  await assert.rejects(
    stopWorkerAndCloseOrigin({ stop: async () => { throw stopError; } }, server),
    (error) => error instanceof AggregateError
      && error.errors[0] === stopError
      && error.errors[1]?.code === 'ERR_SERVER_NOT_RUNNING',
  );
});

test('workerd removes disabled sections and retains enabled sections', async () => {
  const { server, baseUrl } = await startFixtureOrigin();
  let worker;

  try {
    worker = await unstable_dev('src/index.ts', {
      config: 'wrangler.toml',
      ip: '127.0.0.1',
      port: 0,
      local: true,
      logLevel: 'error',
      vars: {
        ORIGIN_BASE_URL: baseUrl,
        TOGGLY_API_BASE_URL: baseUrl,
        TOGGLY_APP_KEY: 'edge-test',
        TOGGLY_ENVIRONMENT: 'Production',
        TOGGLY_USAGE_ENABLED: 'false',
        TOGGLY_METRICS_ENABLED: 'false',
      },
    });

    const response = await worker.fetch('http://edge-runtime.test/');
    const html = await response.text();

    assert.equal(response.status, 200, html);
    assert.doesNotMatch(html, /id="disabled"/);
    assert.doesNotMatch(html, /Disabled content/);
    assert.match(html, /id="enabled"/);
    assert.match(html, /Enabled content/);
  } finally {
    await stopWorkerAndCloseOrigin(worker, server);
  }
});
