import { readFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import plan from './api/plan.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/codex-reset-cards.html', ['codex-reset-cards.html', 'text/html; charset=utf-8']],
  ['/zh/codex-reset-cards.html', ['zh/codex-reset-cards.html', 'text/html; charset=utf-8']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
  ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

async function servePlan(incoming, outgoing, url) {
  const connection = new AbortController();
  outgoing.once('close', () => connection.abort());
  const request = new Request(url, {
    method: incoming.method, headers: incoming.headers, signal: connection.signal,
    body: incoming.method === 'POST' ? Readable.toWeb(incoming, { strategy: { highWaterMark: 1 } }) : undefined,
    duplex: 'half',
  });
  const response = await plan.fetch(request);
  if (connection.signal.aborted) return;
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.flushHeaders();
  if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
  else outgoing.end();
}

export function createServer() {
  return createHTTPServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/plan') return await servePlan(request, response, url);
      const asset = assets.get(url.pathname);
      if (!asset) return response.writeHead(404).end();
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      }
      const [file, type] = asset;
      const content = await readFile(new URL(`./public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.destroyed) return;
      console.error(error);
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createServer();
  server.listen(Number(process.env.RESETWISE_PORT ?? 3000), '127.0.0.1', () => {
    console.log(`Resetwise http://127.0.0.1:${server.address().port}/`);
  });
}
