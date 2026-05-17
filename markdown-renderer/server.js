import { createServer } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DESIGN_PACKS_DIR = join(__dirname, '..', 'design-packs');
const PORT = 3333;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function buildTree(dir, basePath = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const tree = [];

  // Sort: directories first, then files, both alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const fullPath = join(dir, entry.name);
    const relPath = join(basePath, entry.name);

    if (entry.name.startsWith('.')) continue; // skip hidden files

    if (entry.isDirectory()) {
      const children = await buildTree(fullPath, relPath);
      tree.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      });
    } else if (extname(entry.name) === '.md' || extname(entry.name) === '.json') {
      const info = await stat(fullPath);
      tree.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        ext: extname(entry.name),
        size: info.size,
      });
    }
  }

  return tree;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  // API: list file tree
  if (pathname === '/api/tree') {
    try {
      const tree = await buildTree(DESIGN_PACKS_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tree));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: read file content
  if (pathname.startsWith('/api/file/')) {
    const filePath = decodeURIComponent(pathname.slice('/api/file/'.length));
    const fullPath = join(DESIGN_PACKS_DIR, filePath);

    // Security: prevent path traversal
    const resolved = join(DESIGN_PACKS_DIR, filePath);
    if (!resolved.startsWith(DESIGN_PACKS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
    return;
  }

  // Serve static files from public/
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = join(__dirname, 'public', filePath);

  // Security check
  if (!fullPath.startsWith(join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  📄 Markdown Renderer running at http://0.0.0.0:${PORT}\n`);
  console.log(`  📁 Serving design-packs from: ${DESIGN_PACKS_DIR}\n`);
});
