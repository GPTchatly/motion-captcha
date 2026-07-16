import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeConfig } from './lib/http-security.mjs';
import { handleRequest } from './lib/server-router.mjs';
import {
  createRuntimeState,
  disposeRuntimeState,
  parsePort
} from './lib/server-runtime.mjs';

const projectDirectory = resolve(fileURLToPath(new URL('./', import.meta.url)));
const resources = Object.freeze({
  publicDirectory: resolve(projectDirectory, 'public'),
  protectedIndexPath: resolve(projectDirectory, 'protected/index.html'),
  maskLibrary: JSON.parse(
    await fs.readFile(resolve(projectDirectory, 'server-assets/glyph-masks.json'), 'utf8')
  )
});

export async function startMotionCaptchaServer({
  env = process.env,
  host = '0.0.0.0',
  port = parsePort(env.PORT ?? '3000'),
  publicHostname = host === '0.0.0.0' || host === '::' ? 'localhost' : host,
  onChallengeCreated
} = {}) {
  let state = null;
  const needsDynamicDevelopmentOrigin = port === 0 && !env.PUBLIC_ORIGIN && env.NODE_ENV !== 'production';

  if (!needsDynamicDevelopmentOrigin) {
    state = createRuntimeState(createRuntimeConfig(env, port), onChallengeCreated);
  }

  const server = createServer(
    { maxHeaderSize: 16_384 },
    (request, response) => {
      void handleRequest(request, response, state, resources);
    }
  );
  server.maxConnections = state?.config.maxConnections ?? 256;
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.timeout = 15_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(port, host, () => {
        server.off('error', rejectPromise);
        resolvePromise();
      });
    });
  } catch (error) {
    disposeRuntimeState(state);
    throw error;
  }

  if (!state) {
    const address = server.address();
    const assignedPort = typeof address === 'object' && address ? address.port : port;
    const developmentEnv = {
      ...env,
      PUBLIC_ORIGIN: `http://${publicHostname}:${assignedPort}`
    };
    state = createRuntimeState(createRuntimeConfig(developmentEnv, assignedPort), onChallengeCreated);
    server.maxConnections = state.config.maxConnections;
  }

  return {
    server,
    publicOrigin: state.config.publicOrigin,
    async close() {
      disposeRuntimeState(state);
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        server.closeAllConnections?.();
      });
    }
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const runningServer = await startMotionCaptchaServer();
  console.log(`Motion-CAPTCHA running at ${runningServer.publicOrigin}`);
}
