/**
 * Scan a built desktop app for anything that must never ship.
 *
 *   npm run desktop:scan               scans every unpacked app under dist/
 *   npm run desktop:scan -- <dir>      scans the unpacked apps under <dir>
 *
 * WHAT IT READS: the unpacked application - win-unpacked/, mac*\/SevenAI.app -
 * which is exactly what the installer and the DMG are built from. Every file
 * inside app.asar is read from the archive, and every unpacked file is read
 * from disk. The installer .exe/.dmg themselves are compressed containers and
 * scanning their bytes would prove nothing.
 *
 * WHAT FAILS THE SCAN
 *   - a secret VALUE from this checkout's .env (provider keys, edge keys, cloud
 *     keys, DATABASE_URL, the Supabase service role key and JWT secret, R2
 *     credentials) found anywhere in the app. Values are compared in memory and
 *     NEVER printed - only the variable name and the file are reported.
 *   - a secret SHAPE, for machines with no .env (CI): Anthropic/OpenAI key
 *     prefixes, a postgres URL with a password, a JWT whose role is
 *     service_role, a private key block.
 *   - files that are data, not application: .env, auth.json, device.json,
 *     sessions/, cache/, work/, presentation media, certificates.
 *   - a missing required file: the server, the Electron host, the preload, the
 *     wake-word native addon and model - UNPACKED, where native code can read
 *     them.
 *
 * ALLOWED, because they are public by design: the production cloud URL and the
 * Supabase anon/publishable key.
 *
 * Exit code 0 = clean, 1 = findings, 2 = nothing to scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const asar = require('@electron/asar');

const target = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));

// ------------------------------------------------------ what to look for ---

const SECRET_ENV = [
  /_API_KEY$/, /_EDGE_KEY$/, /_CLOUD_KEY$/, /^AZURE_SPEECH_KEY$/, /^DATABASE_URL$/,
  /^SUPABASE_SERVICE_ROLE_KEY$/, /^SUPABASE_JWT_SECRET$/, /^R2_.*(KEY|SECRET).*$/,
];

function secretValuesFromEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return [];
  const { parse } = require('dotenv');
  const parsed = parse(fs.readFileSync(file));
  return Object.entries(parsed)
    .filter(([name, value]) => SECRET_ENV.some((re) => re.test(name)) && typeof value === 'string' && value.trim().length >= 12)
    .map(([name, value]) => ({ name, value: Buffer.from(value.trim()) }));
}

const SHAPES = [
  { name: 'Anthropic API key', re: /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'postgres URL with password', re: /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{6,}@/ },
  // Header AND real key material: libraries (jose, dotenv's README) name the
  // header as a string without carrying a key.
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*(?:[A-Za-z0-9+/=]{40,}\s*){3,}-----END/ },
];

/** A JWT that grants service_role is a server credential, whatever its variable name. */
function serviceRoleJwt(text) {
  const jwts = text.match(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) || [];
  for (const jwt of jwts) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
      if (payload && payload.role === 'service_role') return true;
    } catch {
      /* not a JWT after all */
    }
  }
  return false;
}

// Data folders are anchored to the APP ROOT: a library's own source folder
// called sessions/ or cache/ is code, not somebody's meeting. File-name rules
// apply outside node_modules, where the app's own files live.
const FORBIDDEN_PATHS = [
  { name: '.env file', re: /^(?!node_modules\/)(.*\/)?\.env(\.local)?$/ },
  { name: 'refresh token file', re: /^(?!node_modules\/)(.*\/)?auth\.json$/ },
  { name: 'device id file', re: /^(?!node_modules\/)(.*\/)?device\.json$/ },
  { name: 'Session data', re: /^sessions\// },
  { name: 'cloud cache', re: /^cache\// },
  { name: 'work folder', re: /^work\// },
  { name: 'authored presentations folder', re: /^presentations\// },
  { name: 'presentation media', re: /\.(mp4|mov|m4v|webm)$/i },
  { name: 'certificate or key file', re: /^(?!node_modules\/).*\.(p12|pfx|pem|key|mobileprovision|provisionprofile)$/i },
  { name: 'wake-word test audio', re: /test_wavs\// },
  { name: 'cloud-only dependency (not used by the desktop server)', re: /^node_modules\/(@aws-sdk|@smithy|@supabase|pg|pg-[a-z-]+)\// },
];

const REQUIRED_IN_ASAR = ['package.json', 'server.js', 'electron/main.js', 'electron/server-entry.mjs', 'electron/preload.cjs', 'public/index.html', 'server/auth-store.js'];

// ------------------------------------------------------------- scanning ----

function findApps(dir) {
  const apps = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name === 'app.asar') apps.push(path.dirname(full));
      else if (e.isDirectory() && !e.name.endsWith('.asar.unpacked') && e.name !== 'node_modules') walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return apps;
}

function* unpackedFiles(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* unpackedFiles(full, base);
    else if (e.isFile()) yield { rel: path.relative(base, full).split(path.sep).join('/'), read: () => fs.readFileSync(full), size: fs.statSync(full).size };
  }
}

function* asarFiles(archive) {
  for (const entry of asar.listPackage(archive)) {
    const rel = entry.replace(/^[\\/]/, '').split(path.sep).join('/');
    let stat;
    try {
      stat = asar.statFile(archive, entry.replace(/^[\\/]/, ''));
    } catch {
      continue;
    }
    if (!stat || stat.files || stat.link) continue;
    // Unpacked entries live beside the archive and are scanned from disk.
    if (stat.unpacked) continue;
    yield { rel, read: () => asar.extractFile(archive, entry.replace(/^[\\/]/, '')), size: stat.size };
  }
}

const MAX_TEXT_SCAN = 25 * 1024 * 1024;

function scanApp(resourcesDir, secrets) {
  const findings = [];
  const archive = path.join(resourcesDir, 'app.asar');
  const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
  let files = 0;
  let bytes = 0;
  const asarNames = new Set();
  const unpackedNames = new Set();

  const sources = [
    ...Array.from(asarFiles(archive), (f) => ({ ...f, where: 'app.asar' })),
    ...(fs.existsSync(unpacked) ? Array.from(unpackedFiles(unpacked), (f) => ({ ...f, where: 'app.asar.unpacked' })) : []),
  ];

  for (const f of sources) {
    files += 1;
    bytes += f.size || 0;
    (f.where === 'app.asar' ? asarNames : unpackedNames).add(f.rel);

    for (const rule of FORBIDDEN_PATHS) {
      if (rule.re.test(f.rel)) findings.push(`${rule.name}: ${f.where}/${f.rel}`);
    }
    if (f.size > MAX_TEXT_SCAN) continue;

    const buf = f.read();
    for (const s of secrets) {
      if (buf.includes(s.value)) findings.push(`value of ${s.name} (from .env): ${f.where}/${f.rel}`);
    }
    // Binary files are still checked for exact secret values above; pattern
    // matching is for text, where a key could have been pasted.
    if (buf.includes(0) && !/\.(js|mjs|cjs|json|html|css|md|txt)$/i.test(f.rel)) continue;
    const text = buf.toString('utf8');
    for (const shape of SHAPES) {
      if (shape.re.test(text)) findings.push(`${shape.name}: ${f.where}/${f.rel}`);
    }
    if (serviceRoleJwt(text)) findings.push(`Supabase service_role JWT: ${f.where}/${f.rel}`);
  }

  for (const req of REQUIRED_IN_ASAR) {
    if (!asarNames.has(req)) findings.push(`missing required file in app.asar: ${req}`);
  }
  const nativeAddon = [...unpackedNames].filter((n) => /^node_modules\/sherpa-onnx-[a-z]+-[a-z0-9]+\/sherpa-onnx\.node$/.test(n));
  if (!nativeAddon.length) findings.push('missing UNPACKED wake-word native addon (node_modules/sherpa-onnx-<platform>/sherpa-onnx.node)');
  for (const m of ['encoder', 'decoder', 'joiner']) {
    const hit = [...unpackedNames].some((n) => n.startsWith('models/sherpa-wakeword/') && n.endsWith(`${m}-epoch-12-avg-2-chunk-16-left-64.onnx`));
    if (!hit) findings.push(`missing UNPACKED wake-word model: ${m}`);
  }
  if (![...unpackedNames].includes('models/sherpa-wakeword/hey-seven.txt')) findings.push('missing UNPACKED wake-word keyword file');

  return { findings, files, bytes, nativeAddon };
}

// ----------------------------------------------------------------- main ----

const apps = findApps(target);
if (!apps.length) {
  console.error(`No packaged app (app.asar) found under ${target}. Build one first: npm run electron:build:win`);
  process.exit(2);
}

const secrets = secretValuesFromEnvFile();
console.log(`Secret values loaded from .env for comparison: ${secrets.length} (names only: ${secrets.map((s) => s.name).join(', ') || 'none - pattern checks only'})`);

let failed = false;
for (const resources of apps) {
  const { findings, files, bytes, nativeAddon } = scanApp(resources, secrets);
  console.log(`\n${path.relative(ROOT, resources) || resources}`);
  console.log(`  files scanned: ${files} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  wake-word native addon: ${nativeAddon.join(', ') || 'NOT FOUND'}`);
  if (findings.length) {
    failed = true;
    console.log(`  FINDINGS (${findings.length}):`);
    for (const f of findings) console.log(`   - ${f}`);
  } else {
    console.log('  clean: no secrets, no user data, all required files present');
  }
}
process.exit(failed ? 1 : 0);
