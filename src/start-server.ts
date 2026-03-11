#!/usr/bin/env node
import tls from 'node:tls';
import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import type { Options } from '@hono/node-server/dist/types';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import app from './index';
import mcpApp from './mcp/mcp-index';
import { realTimeHandlerNode } from './handlers/realtimeHandlerNode';
import { createNodeWebSocket } from '@hono/node-ws';
import { authZMiddleWare } from './middlewares/auth/authZ';
import { AUTH_SCOPES } from './globals';
import { requestValidator } from './middlewares/requestValidator';
import { AnalyticsBatcher } from './services/analyticsBatcher';
import { buildAgents } from './agentStore';
import { Environment } from './utils/env';
import minimist from 'minimist';
import { Server } from 'node:https';
import { initClickhouse } from './data-stores/clickhouse';
import { initMongo } from './data-stores/mongo';
import { initializeMemCache } from './data-stores/memCache';
import { initCacheKeyTracker } from './utils/cacheKeyTracker';
import { plugins } from './plugins';
import { loadExternalPlugins, mergePlugins } from './loaders/pluginLoader';
import { loadExternalMiddlewares } from './loaders/middlewareLoader';
import { loadExternalProviders } from './loaders/providerLoader';
import { registerProvider } from './providers';
import { installExternalDependencies } from './utils/externalDependencyInstaller';

const TIMEOUT = 15 * 60 * 1000; // 15 minutes

await initClickhouse();
await initMongo();
initializeMemCache();

// Extract the port number from the command line arguments
const argv = minimist(process.argv.slice(2), {
  default: {
    port: Number(Environment({}).PORT),
    'mcp-port': Number(Environment({}).MCP_PORT),
  },
  boolean: ['llm-node', 'mcp-node', 'llm-grpc', 'headless'],
});

import { plugins } from './plugins';
import { loadExternalPlugins, mergePlugins } from './loaders/pluginLoader';
import { loadExternalMiddlewares } from './loaders/middlewareLoader';
import { loadExternalProviders } from './loaders/providerLoader';
import { registerProvider } from './providers';
import { installExternalDependencies } from './utils/externalDependencyInstaller';

const isHeadless = argv.headless;

// Parse external plugin and middleware directories
const pluginsDirArg = process.argv.find((arg) =>
  arg.startsWith('--plugins-dir=')
);
const pluginsDir = pluginsDirArg ? pluginsDirArg.split('=')[1] : null;

const middlewaresDirArg = process.argv.find((arg) =>
  arg.startsWith('--middlewares-dir=')
);
const middlewaresDir = middlewaresDirArg
  ? middlewaresDirArg.split('=')[1]
  : null;

const providersDirArg = process.argv.find((arg) =>
  arg.startsWith('--providers-dir=')
);
const providersDir = providersDirArg ? providersDirArg.split('=')[1] : null;

// Install external dependencies if external plugins/middlewares/providers are specified
const dirsToInstallDeps: string[] = [];
if (pluginsDir) dirsToInstallDeps.push(pluginsDir);
if (middlewaresDir) dirsToInstallDeps.push(middlewaresDir);
if (providersDir) dirsToInstallDeps.push(providersDir);

if (dirsToInstallDeps.length > 0) {
  console.log('📦 Installing external dependencies...');
  try {
    // Read gateway's package.json from the file system
    let packageJsonPath: string;

    // Get current directory in ES modules
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try multiple possible locations for package.json
    const possiblePaths = [
      path.resolve('./package.json'),
      path.resolve('../package.json'),
      path.resolve(__dirname, '../../package.json'),
      path.resolve(process.cwd(), 'package.json'),
    ];

    let gatewayPackageJson: Record<string, any> | null = null;
    for (const tryPath of possiblePaths) {
      if (fs.existsSync(tryPath)) {
        try {
          const content = fs.readFileSync(tryPath, 'utf-8');
          gatewayPackageJson = JSON.parse(content);
          packageJsonPath = tryPath;
          break;
        } catch {
          // Continue to next path
        }
      }
    }

    if (!gatewayPackageJson) {
      throw new Error(
        'Could not find gateway package.json in any expected location'
      );
    }

    const installResult = await installExternalDependencies(
      dirsToInstallDeps,
      gatewayPackageJson
    );

    // Report installation status
    if (Object.keys(installResult.installed).length > 0) {
      console.log('✓ Dependencies installed for external packages\n');
    }

    if (Object.keys(installResult.peerDependencyMismatches).length > 0) {
      console.error('\n❌ Peer dependency mismatches detected:');
      for (const [dir, error] of Object.entries(
        installResult.peerDependencyMismatches
      )) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }

    if (Object.keys(installResult.failed).length > 0) {
      console.error('\n❌ Failed to install dependencies:');
      for (const [dir, error] of Object.entries(installResult.failed)) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error installing external dependencies:', error.message);
    process.exit(1);
  }
}

// Load external providers if specified
if (providersDir) {
  console.log('🔗 Loading external providers from:', providersDir);
  try {
    const externalProviders = await loadExternalProviders([providersDir]);

    for (const { name, config } of externalProviders) {
      registerProvider(name, config);
    }

    if (externalProviders.length > 0) {
      console.log('✓ External providers loaded\n');
    }
  } catch (error: any) {
    console.error('❌ Error loading providers:', error.message);
    process.exit(1);
  }
}

// Load external plugins if specified
if (pluginsDir) {
  console.log('🔌 Loading external plugins from:', pluginsDir);
  try {
    const externalPlugins = await loadExternalPlugins([pluginsDir]);
    const merged = mergePlugins(plugins, externalPlugins);
    Object.assign(plugins, merged);
    console.log('✓ External plugins loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading plugins:', error.message);
    process.exit(1);
  }
}

// Load external middlewares if specified
if (middlewaresDir) {
  console.log('⚙️  Loading external middlewares from:', middlewaresDir);
  try {
    const externalMiddlewares = await loadExternalMiddlewares([middlewaresDir]);

    for (const mw of externalMiddlewares) {
      console.log(`  ↳ Registering middleware: ${mw.name}`);
      if (mw.appExtension) {
        // App extension middleware: receives app instance and can register routes
        (mw.handler as (app: any) => void)(app);
      } else {
        // Standard middleware: register as request handler
        app.use(
          mw.pattern || '*',
          mw.handler as (c: any, next: any) => Promise<any>
        );
      }
    }

    console.log('✓ External middlewares loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading middlewares:', error.message);
    process.exit(1);
  }
}

// Parse external plugin and middleware directories
const pluginsDirArg = args.find((arg) => arg.startsWith('--plugins-dir='));
const pluginsDir = pluginsDirArg ? pluginsDirArg.split('=')[1] : null;

const middlewaresDirArg = args.find((arg) =>
  arg.startsWith('--middlewares-dir=')
);
const middlewaresDir = middlewaresDirArg
  ? middlewaresDirArg.split('=')[1]
  : null;

const providersDirArg = args.find((arg) => arg.startsWith('--providers-dir='));
const providersDir = providersDirArg ? providersDirArg.split('=')[1] : null;

// Install external dependencies if external plugins/middlewares/providers are specified
const dirsToInstallDeps: string[] = [];
if (pluginsDir) dirsToInstallDeps.push(pluginsDir);
if (middlewaresDir) dirsToInstallDeps.push(middlewaresDir);
if (providersDir) dirsToInstallDeps.push(providersDir);

if (dirsToInstallDeps.length > 0) {
  console.log('📦 Installing external dependencies...');
  try {
    // Read gateway's package.json from the file system
    let packageJsonPath: string;

    // Get current directory in ES modules
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try multiple possible locations for package.json
    const possiblePaths = [
      path.resolve('./package.json'),
      path.resolve('../package.json'),
      path.resolve(__dirname, '../../package.json'),
      path.resolve(process.cwd(), 'package.json'),
    ];

    let gatewayPackageJson: Record<string, any> | null = null;
    for (const tryPath of possiblePaths) {
      if (fs.existsSync(tryPath)) {
        try {
          const content = fs.readFileSync(tryPath, 'utf-8');
          gatewayPackageJson = JSON.parse(content);
          packageJsonPath = tryPath;
          break;
        } catch {
          // Continue to next path
        }
      }
    }

    if (!gatewayPackageJson) {
      throw new Error(
        'Could not find gateway package.json in any expected location'
      );
    }

    const installResult = await installExternalDependencies(
      dirsToInstallDeps,
      gatewayPackageJson
    );

    // Report installation status
    if (Object.keys(installResult.installed).length > 0) {
      console.log('✓ Dependencies installed for external packages\n');
    }

    if (Object.keys(installResult.peerDependencyMismatches).length > 0) {
      console.error('\n❌ Peer dependency mismatches detected:');
      for (const [dir, error] of Object.entries(
        installResult.peerDependencyMismatches
      )) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }

    if (Object.keys(installResult.failed).length > 0) {
      console.error('\n❌ Failed to install dependencies:');
      for (const [dir, error] of Object.entries(installResult.failed)) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error installing external dependencies:', error.message);
    process.exit(1);
  }
}

// Load external providers if specified
if (providersDir) {
  console.log('🔗 Loading external providers from:', providersDir);
  try {
    const externalProviders = await loadExternalProviders([providersDir]);

    for (const { name, config } of externalProviders) {
      registerProvider(name, config);
    }

    if (externalProviders.length > 0) {
      console.log('✓ External providers loaded\n');
    }
  } catch (error: any) {
    console.error('❌ Error loading providers:', error.message);
    process.exit(1);
  }
}

// Load external plugins if specified
if (pluginsDir) {
  console.log('🔌 Loading external plugins from:', pluginsDir);
  try {
    const externalPlugins = await loadExternalPlugins([pluginsDir]);
    const merged = mergePlugins(plugins, externalPlugins);
    Object.assign(plugins, merged);
    console.log('✓ External plugins loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading plugins:', error.message);
    process.exit(1);
  }
}

// Load external middlewares if specified
if (middlewaresDir) {
  console.log('⚙️  Loading external middlewares from:', middlewaresDir);
  try {
    const externalMiddlewares = await loadExternalMiddlewares([middlewaresDir]);

    for (const mw of externalMiddlewares) {
      console.log(`  ↳ Registering middleware: ${mw.name}`);
      if (mw.appExtension) {
        // App extension middleware: receives app instance and can register routes
        (mw.handler as (app: any) => void)(app);
      } else {
        // Standard middleware: register as request handler
        app.use(
          mw.pattern || '*',
          mw.handler as (c: any, next: any) => Promise<any>
        );
      }
    }

    console.log('✓ External middlewares loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading middlewares:', error.message);
    process.exit(1);
  }
}

// Parse external plugin and middleware directories
const pluginsDirArg = args.find((arg) => arg.startsWith('--plugins-dir='));
const pluginsDir = pluginsDirArg ? pluginsDirArg.split('=')[1] : null;

const middlewaresDirArg = args.find((arg) =>
  arg.startsWith('--middlewares-dir=')
);
const middlewaresDir = middlewaresDirArg
  ? middlewaresDirArg.split('=')[1]
  : null;

const providersDirArg = args.find((arg) => arg.startsWith('--providers-dir='));
const providersDir = providersDirArg ? providersDirArg.split('=')[1] : null;

// Install external dependencies if external plugins/middlewares/providers are specified
const dirsToInstallDeps: string[] = [];
if (pluginsDir) dirsToInstallDeps.push(pluginsDir);
if (middlewaresDir) dirsToInstallDeps.push(middlewaresDir);
if (providersDir) dirsToInstallDeps.push(providersDir);

if (dirsToInstallDeps.length > 0) {
  console.log('📦 Installing external dependencies...');
  try {
    // Read gateway's package.json from the file system
    let packageJsonPath: string;

    // Get current directory in ES modules
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try multiple possible locations for package.json
    const possiblePaths = [
      path.resolve('./package.json'),
      path.resolve('../package.json'),
      path.resolve(__dirname, '../../package.json'),
      path.resolve(process.cwd(), 'package.json'),
    ];

    let gatewayPackageJson: Record<string, any> | null = null;
    for (const tryPath of possiblePaths) {
      if (fs.existsSync(tryPath)) {
        try {
          const content = fs.readFileSync(tryPath, 'utf-8');
          gatewayPackageJson = JSON.parse(content);
          packageJsonPath = tryPath;
          break;
        } catch {
          // Continue to next path
        }
      }
    }

    if (!gatewayPackageJson) {
      throw new Error(
        'Could not find gateway package.json in any expected location'
      );
    }

    const installResult = await installExternalDependencies(
      dirsToInstallDeps,
      gatewayPackageJson
    );

    // Report installation status
    if (Object.keys(installResult.installed).length > 0) {
      console.log('✓ Dependencies installed for external packages\n');
    }

    if (Object.keys(installResult.peerDependencyMismatches).length > 0) {
      console.error('\n❌ Peer dependency mismatches detected:');
      for (const [dir, error] of Object.entries(
        installResult.peerDependencyMismatches
      )) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }

    if (Object.keys(installResult.failed).length > 0) {
      console.error('\n❌ Failed to install dependencies:');
      for (const [dir, error] of Object.entries(installResult.failed)) {
        console.error(`  ${dir}: ${error}`);
      }
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error installing external dependencies:', error.message);
    process.exit(1);
  }
}

// Load external providers if specified
if (providersDir) {
  console.log('🔗 Loading external providers from:', providersDir);
  try {
    const externalProviders = await loadExternalProviders([providersDir]);

    for (const { name, config } of externalProviders) {
      registerProvider(name, config);
    }

    if (externalProviders.length > 0) {
      console.log('✓ External providers loaded\n');
    }
  } catch (error: any) {
    console.error('❌ Error loading providers:', error.message);
    process.exit(1);
  }
}

// Load external plugins if specified
if (pluginsDir) {
  console.log('🔌 Loading external plugins from:', pluginsDir);
  try {
    const externalPlugins = await loadExternalPlugins([pluginsDir]);
    const merged = mergePlugins(plugins, externalPlugins);
    Object.assign(plugins, merged);
    console.log('✓ External plugins loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading plugins:', error.message);
    process.exit(1);
  }
}

// Load external middlewares if specified
if (middlewaresDir) {
  console.log('⚙️  Loading external middlewares from:', middlewaresDir);
  try {
    const externalMiddlewares = await loadExternalMiddlewares([middlewaresDir]);

    for (const mw of externalMiddlewares) {
      console.log(`  ↳ Registering middleware: ${mw.name}`);
      if (mw.appExtension) {
        // App extension middleware: receives app instance and can register routes
        (mw.handler as (app: any) => void)(app);
      } else {
        // Standard middleware: register as request handler
        app.use(
          mw.pattern || '*',
          mw.handler as (c: any, next: any) => Promise<any>
        );
      }
    }

    console.log('✓ External middlewares loaded\n');
  } catch (error: any) {
    console.error('❌ Error loading middlewares:', error.message);
    process.exit(1);
  }
}

// Setup static file serving only if not in headless mode
if (
  !isHeadless &&
  !(
    process.env.NODE_ENV === 'production' ||
    process.env.ENVIRONMENT === 'production'
  )
) {
  const setupStaticServing = async () => {
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const { readFileSync } = await import('fs');

    const scriptDir = dirname(fileURLToPath(import.meta.url));

    // Serve the index.html content directly for both routes
    const indexPath = join(scriptDir, 'public/index.html');
    const indexContent = readFileSync(indexPath, 'utf-8');

    const serveIndex = (c: Context) => {
      return c.html(indexContent);
    };

    // Set up routes
    app.get('/public/logs', serveIndex);
    app.get('/public/', serveIndex);

    // Redirect `/public` to `/public/`
    app.get('/public', (c: Context) => {
      return c.redirect('/public/');
    });
  };

  // Initialize static file serving
  // Initialize static file serving
  await setupStaticServing();

  /**
   * A helper function to enforce a timeout on SSE sends.
   * @param fn A function that returns a Promise (e.g. stream.writeSSE())
   * @param timeoutMs The timeout in milliseconds (default: 2000)
   */
  async function sendWithTimeout(fn: () => Promise<void>, timeoutMs = 200) {
    const timeoutPromise = new Promise<void>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error('Write timeout'));
      }, timeoutMs);
    });

    return Promise.race([fn(), timeoutPromise]);
  }

  app.get('/log/stream', (c: Context) => {
    const clientId = Date.now().toString();

    // Set headers to prevent caching
    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      const addLogClient: any = c.get('addLogClient');
      const removeLogClient: any = c.get('removeLogClient');

      const client = {
        sendLog: (message: any) =>
          sendWithTimeout(() => stream.writeSSE(message)),
      };
      // Add this client to the set of log clients
      addLogClient(clientId, client);

      // If the client disconnects (closes the tab, etc.), this signal will be aborted
      const onAbort = () => {
        removeLogClient(clientId);
      };
      c.req.raw.signal.addEventListener('abort', onAbort);

      try {
        // Send an initial connection event
        await sendWithTimeout(() =>
          stream.writeSSE({ event: 'connected', data: clientId })
        );

        // Use an interval instead of a while loop
        const heartbeatInterval = setInterval(async () => {
          if (c.req.raw.signal.aborted) {
            clearInterval(heartbeatInterval);
            return;
          }

          try {
            await sendWithTimeout(() =>
              stream.writeSSE({ event: 'heartbeat', data: 'pulse' })
            );
          } catch (error) {
            // console.error(`Heartbeat failed for client ${clientId}:`, error);
            clearInterval(heartbeatInterval);
            removeLogClient(clientId);
          }
        }, 10000);

        // Wait for abort signal
        await new Promise((resolve) => {
          c.req.raw.signal.addEventListener('abort', () => {
            clearInterval(heartbeatInterval);
            resolve(undefined);
          });
        });
      } catch (error) {
        // console.error(`Error in log stream for client ${clientId}:`, error);
      } finally {
        // Remove this client when the connection is closed
        removeLogClient(clientId);
        c.req.raw.signal.removeEventListener('abort', onAbort);
      }
    });
  });
}

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.get(
  '/v1/realtime',
  requestValidator,
  upgradeWebSocket(realTimeHandlerNode)
);

const port = argv.port;
const mcpPort = argv['mcp-port'];

// Add flags to choose what all to start (llm-node, llm-grpc, mcp-node)
// Default starts both llm-node and mcp-node

let llmNode = argv['llm-node'];
let mcpNode = argv['mcp-node'];
let llmGrpc = argv['llm-grpc'];

if (!llmNode && !mcpNode && !llmGrpc) {
  llmNode = true;
}

const tlsKeyPath = Environment({}).TLS_KEY_PATH;
const tlsCertPath = Environment({}).TLS_CERT_PATH;
const tlsCaPath = Environment({}).TLS_CA_PATH;

let tlsKey = Environment({}).TLS_KEY;
let tlsCert = Environment({}).TLS_CERT;
let tlsCa = Environment({}).TLS_CA;
const defaultCAs = tls.rootCertificates;

if (tlsKeyPath && tlsCertPath) {
  try {
    tlsKey = readFileSync(tlsKeyPath, 'utf-8');
    tlsCert = readFileSync(tlsCertPath, 'utf-8');
    if (tlsCaPath) {
      tlsCa = readFileSync(tlsCaPath, 'utf-8');
    }
  } catch (error) {
    console.error('Error reading TLS keys:', error);
  }
}

const agentConfig: any = {};

// Configure TLS for all agents (automatically builds agents with proxy/timeout/TLS)
if ((tlsKey && tlsCert) || tlsCa) {
  agentConfig.options = {
    ...(tlsKey && { key: tlsKey }),
    ...(tlsCert && { cert: tlsCert }),
    ...(tlsCa ? { ca: [...defaultCAs, tlsCa] } : {}),
    allowHTTP1: true,
  };
}

buildAgents(agentConfig);

if (mcpNode) {
  const mcpUrl = `http://localhost:${mcpPort}`;
  const mcpServerOptions: Options = {
    fetch: mcpApp.fetch,
    port: mcpPort,
  };

  if (tlsKeyPath && tlsCertPath) {
    mcpServerOptions.createServer = createSecureServer;
  }

  if ((tlsKey && tlsCert) || tlsCa) {
    mcpServerOptions.serverOptions = agentConfig.options;
  }

  const mcpServer = serve(mcpServerOptions) as Server;
  mcpServer.setTimeout(TIMEOUT);
  mcpServer.requestTimeout = TIMEOUT;
  mcpServer.headersTimeout = TIMEOUT;

  console.log('\x1b[1m%s\x1b[0m', '🤯 MCP Gateway is running at:');
  console.log('   ' + '\x1b[1;4;32m%s\x1b[0m', `${mcpUrl}`);
}

if (llmNode) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/v1/realtime',
    authZMiddleWare([AUTH_SCOPES.COMPLETIONS.WRITE]),
    requestValidator,
    upgradeWebSocket(realTimeHandlerNode)
  );

  const serverOptions: Options = {
    fetch: app.fetch,
    port: port,
  };

  if (tlsKeyPath && tlsCertPath) {
    serverOptions.createServer = createSecureServer;
  }

  if ((tlsKey && tlsCert) || tlsCa) {
    serverOptions.serverOptions = agentConfig.options;
  }

  const server = serve(serverOptions) as Server;

  initCacheKeyTracker();

  server.setTimeout(TIMEOUT);
  server.requestTimeout = TIMEOUT;
  server.headersTimeout = TIMEOUT;

  injectWebSocket(server);
  console.log(`Your AI Gateway is now running on http://localhost:${port} 🚀`);
}

// Add a cleanup function to flush remaining items on process exit
process.on('SIGTERM', async () => {
  if (AnalyticsBatcher.getInstance()) {
    await AnalyticsBatcher.getInstance().flush();
  }
});

process.on('SIGINT', async () => {
  if (AnalyticsBatcher.getInstance()) {
    await AnalyticsBatcher.getInstance().flush();
  }
});

process.on('uncaughtException', (err) => {
  console.error('Unhandled exception', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection', err);
});
