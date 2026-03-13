# StringCost Patches to Upstream Portkey Gateway

This document describes customizations made to the upstream Portkey Gateway for StringCost integration. These are candidates for upstreaming.

---

## 1. DEBUG_HOOKS Environment Variable Logging

**File:** `src/middlewares/hooks/index.ts`

**Purpose:** Adds optional debug logging for the hooks/guardrails system, controlled by `DEBUG_HOOKS=true` environment variable. This is invaluable for debugging custom plugins and understanding hook execution flow.

### Patch 1A: HookSpan Constructor Logging

**Location:** After `this.id = crypto.randomUUID();` in the HookSpan constructor

**Code Added:**
```typescript
if (process.env.DEBUG_HOOKS) {
  console.log('[HookSpan] Created with:', {
    beforeRequestHooks: beforeRequestHooks.length,
    afterRequestHooks: afterRequestHooks.length,
    beforeRequestHooksDetail: beforeRequestHooks.map(h => ({
      id: h.id,
      checks: h.checks,
      checkIds: h.checks?.map(c => typeof c === 'string' ? `(string)"${c}"` : `(object)${c.id}`)
    })),
    afterRequestHooksDetail: afterRequestHooks.map(h => ({
      id: h.id,
      checks: h.checks,
      checkIds: h.checks?.map(c => typeof c === 'string' ? `(string)"${c}"` : `(object)${c.id}`)
    })),
  });
}
```

**Why:** When developing custom guardrail hooks, it's difficult to know if hooks are being registered correctly. This logs:
- Number of before/after request hooks
- Hook IDs and their check configurations
- Whether checks are string references or object definitions

---

### Patch 1B: HooksManager Constructor Logging

**Location:** After `this.plugins = plugins;` in the HooksManager constructor

**Code Added:**
```typescript
if (process.env.DEBUG_HOOKS) {
  console.log('[HooksManager] Available plugins:', Object.keys(this.plugins));
  if (this.plugins.stringcost) {
    console.log('[HooksManager] stringcost plugin functions:', Object.keys(this.plugins.stringcost));
  }
}
```

**Why:** Shows which plugins are loaded and available. Helps diagnose "plugin not found" errors by confirming:
- Which plugin namespaces are registered
- Which functions exist within each plugin

**Note:** The `stringcost` check could be generalized to log all plugin functions:
```typescript
if (process.env.DEBUG_HOOKS) {
  console.log('[HooksManager] Available plugins:', Object.keys(this.plugins));
  for (const [name, plugin] of Object.entries(this.plugins)) {
    console.log(`[HooksManager] ${name} plugin functions:`, Object.keys(plugin as object));
  }
}
```

---

### Patch 1C: executeFunction Debug Logging

**Location:** In `executeFunction()`, after extracting source/fn from check.id

**Code Added:**
```typescript
if (process.env.DEBUG_HOOKS) {
  console.log(`[executeFunction] Attempting to call ${source}.${fn}`);
  console.log(`[executeFunction] Source exists: ${!!this.plugins[source]}`);
  if (this.plugins[source]) {
    console.log(`[executeFunction] Function exists: ${!!this.plugins[source][fn]}`);
  }
}
```

**Why:** When a hook fails to execute, this pinpoints whether:
- The plugin namespace exists (`source`)
- The specific function exists within that plugin (`fn`)
- The check.id format is correct (e.g., `stringcost.guardrail`)

---

## Usage

Enable debug logging by setting the environment variable:

```bash
DEBUG_HOOKS=true npm run dev:node -- --plugins-dir=../stringcost/plugins
```

Example output:
```
[HooksManager] Available plugins: [ 'default', 'stringcost' ]
[HooksManager] stringcost plugin functions: [ 'guardrail', 'logEvent' ]
[HookSpan] Created with: {
  beforeRequestHooks: 1,
  afterRequestHooks: 1,
  beforeRequestHooksDetail: [ { id: 'stringcost-before', checks: [Array], checkIds: ['(object)stringcost.guardrail'] } ],
  afterRequestHooksDetail: [ { id: 'stringcost-after', checks: [Array], checkIds: ['(object)stringcost.logEvent'] } ]
}
[executeFunction] Attempting to call stringcost.guardrail
[executeFunction] Source exists: true
[executeFunction] Function exists: true
```

---

## Recommendation for Upstream

These patches add zero overhead when `DEBUG_HOOKS` is not set (the `if` checks are trivial). They significantly improve the developer experience when:

1. Building custom guardrail plugins
2. Debugging hook registration issues
3. Understanding the hook execution flow
4. Troubleshooting "function not found" errors

Consider adding this as a standard debugging feature with documentation in the plugin development guide.

---

## 2. Skip Dependency Installation When Already Present

**File:** `src/utils/externalDependencyInstaller.ts`

**Purpose:** Skip `npm install` if dependencies are already installed, enabling deployment in environments without npm (e.g., bun-only containers).

**Code Added (after peer dependency validation, before install):**
```typescript
// Check if dependencies are already installed or not needed
const nodeModulesPath = path.join(absoluteDir, 'node_modules');
const deps = packageJson.dependencies || {};
const depNames = Object.keys(deps);

// Skip if no dependencies defined
if (depNames.length === 0) {
  console.log(`  ✓ No dependencies in ${dir}, skipping`);
  result.installed[dir] = 'No dependencies (skipped)';
  continue;
}

// Skip if all dependencies already installed
if (fs.existsSync(nodeModulesPath)) {
  const hasAllDeps = depNames.every(dep =>
    fs.existsSync(path.join(nodeModulesPath, dep))
  );
  if (hasAllDeps) {
    console.log(`  ✓ Dependencies already installed in ${dir}, skipping`);
    result.installed[dir] = 'Already installed (skipped)';
    continue;
  }
}
```

**Why:**
- Allows pre-installing dependencies during Docker build
- Enables deployment in bun-only containers (no npm required at runtime)
- Faster startup when dependencies are unchanged
- More efficient in serverless/container environments

**Use Case:** Our Dockerfile pre-installs with `bun install` during build, then at runtime the installer detects existing node_modules and skips the npm call entirely.

---

## 3. Bun Package Manager Support

**File:** `src/utils/externalDependencyInstaller.ts`

**Purpose:** Make the external dependency installer work with bun in addition to npm.

**Code Added:**
```typescript
/**
 * Detect available package manager (prefers bun over npm)
 */
function detectPackageManager(): 'bun' | 'npm' | null {
  // Try bun first
  try {
    execSync('bun --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'bun';
  } catch {
    // bun not available
  }

  // Try npm
  try {
    execSync('npm --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'npm';
  } catch {
    // npm not available
  }

  return null;
}
```

**Install command updated to use detected package manager:**
```typescript
const packageManager = detectPackageManager();
const installCmd = packageManager === 'bun'
  ? 'bun install --no-save 2>&1'
  : 'npm install --no-save 2>&1';
```

**Why:**
- Bun is increasingly popular and often used in Docker containers
- The `oven/bun` Docker image doesn't include npm
- This enables external plugin/middleware loading in bun-only environments
- Bun's install is significantly faster than npm

---

## 4. Scan Subdirectories for Plugin Dependencies

**File:** `src/utils/externalDependencyInstaller.ts`

**Purpose:** Scan subdirectories for package.json files, not just top-level directories.

**Problem:** When `--plugins-dir=./stringcost/plugins` is passed, the installer only checked `./stringcost/plugins/package.json`. But plugins are in subdirectories like `./stringcost/plugins/stringcost/package.json`.

**Code Added (replacing the simple directory loop):**
```typescript
// Collect all directories with package.json (including subdirectories)
const dirsToProcess: string[] = [];

for (const dir of directories) {
  const absoluteDir = path.resolve(dir);

  if (!fs.existsSync(absoluteDir)) {
    result.failed[dir] = `Directory not found: ${absoluteDir}`;
    result.success = false;
    continue;
  }

  // Check top-level directory
  if (fs.existsSync(path.join(absoluteDir, 'package.json'))) {
    dirsToProcess.push(absoluteDir);
  }

  // Also scan subdirectories (for plugins structure)
  try {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subdir = path.join(absoluteDir, entry.name);
        if (fs.existsSync(path.join(subdir, 'package.json'))) {
          dirsToProcess.push(subdir);
        }
      }
    }
  } catch {
    // Ignore errors scanning subdirectories
  }
}

for (const absoluteDir of dirsToProcess) {
  // ... process each directory with package.json
}
```

**Why:**
- Plugin directories contain subdirectories (e.g., `plugins/stringcost/`, `plugins/another-plugin/`)
- Each plugin subdirectory has its own package.json
- Without this, plugin dependencies are never installed
- Matches how `pluginLoader.ts` scans for plugins (it also scans subdirectories)

**Example:**
```
plugins/
├── stringcost/
│   ├── package.json    ← Now found and processed
│   ├── guardrail.js
│   └── logEvent.js
└── another-plugin/
    ├── package.json    ← Also found and processed
    └── handler.js
```

---

## 5. Rename `isPlugin` to `appExtension` in Middleware Loader

**File:** `src/loaders/middlewareLoader.ts`

**Purpose:** Clarify the meaning of the middleware type flag. The term "isPlugin" was confusing since plugins and middlewares are different concepts in Portkey.

**Changes:**
```typescript
// Interface change
export interface LoadedMiddleware {
  handler: ((c: any, next: any) => Promise<any>) | ((app: any) => void);
  name: string;
  pattern?: string;
  appExtension: boolean; // Renamed from isPlugin
}

// Usage in loader logic
let appExtension = metadata.appExtension === true;  // Was: metadata.isPlugin
```

**File:** `src/start-server.ts`

**Corresponding update:**
```typescript
if (mw.appExtension) {  // Was: mw.isPlugin
  // App extension middleware: receives app instance and can register routes
  (mw.handler as (app: any) => void)(app);
} else {
  // Standard middleware: register as request handler
  app.use(mw.pattern || '*', mw.handler as (c: any, next: any) => Promise<any>);
}
```

**Why:**
- `appExtension: true` clearly indicates the middleware modifies the app instance (wraps fetch, adds routes)
- `isPlugin: true` was confusing because "plugin" has a different meaning (guardrail functions)
- Two middleware patterns exist:
  1. **Standard:** `(c, next) => Promise` - Hono request middleware
  2. **App Extension:** `() => (app) => void` - Wraps app.fetch or adds routes

---

## 6. Plugin Loader Debug Logging

**File:** `src/loaders/pluginLoader.ts`

**Purpose:** Add comprehensive logging to diagnose plugin loading failures. Essential for debugging external plugin issues.

**Code Added:**
```typescript
export async function loadExternalPlugins(pluginsDirs: string[]) {
  const externalPlugins: Record<string, any> = {};

  console.log('[pluginLoader] Loading external plugins from:', pluginsDirs);

  for (const dir of pluginsDirs) {
    const absoluteDir = path.resolve(dir);
    console.log('[pluginLoader] Scanning directory:', absoluteDir);

    // ... existing existence check ...

    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    console.log('[pluginLoader] Found entries:', entries.map(e => e.name));

    for (const entry of entries) {
      // ... existing directory check ...

      console.log('[pluginLoader] Checking plugin:', entry.name, 'at', pluginPath);
      console.log('[pluginLoader] Loading plugin:', pluginId, 'with functions:',
        manifest.functions?.map((f: any) => f.id));

      for (const func of manifest.functions || []) {
        console.log('[pluginLoader] Looking for function file:', funcPath);

        try {
          console.log('[pluginLoader] Importing:', funcPath);
          const module = await import(funcPath);
          console.log('[pluginLoader] Module exports:', Object.keys(module));

          if (typeof module.handler !== 'function') {
            console.warn(`⚠️  ${func.id} in ${pluginId}: 'handler' export is not a function`);
            continue;
          }

          externalPlugins[pluginId][func.id] = module.handler;
          console.log('[pluginLoader] Loaded function:', pluginId + '.' + func.id);
        } catch (error: any) {
          console.warn(`⚠️  Error loading function ${func.id} in ${pluginId}: ${error.message}`);
          console.warn(`⚠️  Stack: ${error.stack}`);
        }
      }

      console.log('[pluginLoader] Plugin', pluginId, 'loaded with functions:',
        Object.keys(externalPlugins[pluginId]));
    }
  }

  console.log('[pluginLoader] All external plugins loaded:', Object.keys(externalPlugins));
  return externalPlugins;
}
```

**Why:**
- Plugin loading failures are silent by default
- External plugins have many failure points: missing files, import errors, wrong exports
- This logging reveals:
  - Which directories are scanned
  - Which plugin folders are found
  - What functions the manifest declares
  - What the JS module actually exports
  - The exact error when imports fail (including dependency issues)

**Example output (successful):**
```
[pluginLoader] Loading external plugins from: [ "./stringcost/plugins" ]
[pluginLoader] Scanning directory: /app/stringcost/plugins
[pluginLoader] Found entries: [ "stringcost" ]
[pluginLoader] Checking plugin: stringcost at /app/stringcost/plugins/stringcost
[pluginLoader] Loading plugin: stringcost with functions: [ "guardrail", "logEvent" ]
[pluginLoader] Importing: /app/stringcost/plugins/stringcost/guardrail.js
[pluginLoader] Module exports: [ "handler" ]
[pluginLoader] Loaded function: stringcost.guardrail
[pluginLoader] Plugin stringcost loaded with functions: [ "guardrail", "logEvent" ]
```

**Example output (failure - missing dependency):**
```
[pluginLoader] Importing: /app/stringcost/plugins/stringcost/guardrail.js
⚠️  Error loading function guardrail in stringcost: Cannot find module 'pg-boss'
⚠️  Stack: Error: Cannot find module 'pg-boss' ...
```

---

## Recommendation for Upstream

All patches are backwards-compatible and add no overhead when not used. They improve:
1. Developer experience with DEBUG_HOOKS
2. Deployment flexibility with the skip-if-installed check
3. Bun runtime support for dependency installation
4. Correct dependency installation for plugin subdirectories
5. Clarity with `appExtension` naming for middleware types
6. Diagnosability with plugin loader debug logging

---

## 7. Migration from Bun to Node.js 24

**File:** `bun.lock` (deleted)

**Purpose:** Remove Bun-specific lock file as part of migrating the entire StringCost project from Bun to Node.js 24.

**Changes:**
- Deleted `bun.lock` file
- Using `package-lock.json` (npm) instead
- Dockerfiles now use `node:26-alpine` base image
- CI uses `actions/setup-node@v4` instead of `oven-sh/setup-bun@v2`

**Why:**
- Node.js 24 is the chosen runtime for production
- Consistent tooling across development and production
- No need for Bun-specific lock file when using npm
- The codebase was already Node.js-compatible (uses esbuild, @hono/node-server, no bun: imports)
