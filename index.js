const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const express = require('express');
const http = require('http');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

chromium.use(stealth);

const PORT = Number(process.env.PORT || 2223);
const HOST = process.env.HOST || (process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1');
const DOMAIN = process.env.DOMAIN || 'localhost';
const UPSTREAM = process.env.UPSTREAM || 'https://gemini.google.com';
const UPSTREAM_ORIGIN = new URL(UPSTREAM).origin;
const UPSTREAM_APP = `${UPSTREAM}/app`;
const DEFAULT_BASE_URL = DOMAIN === 'localhost'
  ? `http://localhost:${PORT}`
  : `https://${DOMAIN}`;
const WS_URL = process.env.WS_URL || '';
const WS_REQUEST_TIMEOUT_MS = Number(process.env.WS_REQUEST_TIMEOUT_MS || 300000);
const SW_VERSION = Date.now().toString();
const JALL_API_URL = process.env.JALL_API_URL || 'http://localhost:3002/api';
const FORCED_WS_TUNNEL_RULES = [
  { origin: 'https://accounts.google.com', pathPrefix: '/RotateCookiesPage' },
  { origin: 'https://signaler-pa.clients6.google.com', pathPrefix: '/punctual/multi-watch/channel' }
];

function isLocalHostName(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
}

function getForwardedProto(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').trim();
  if (xfProto) return xfProto.split(',')[0].trim();
  const xfSsl = String(req.headers['x-forwarded-ssl'] || '').trim();
  if (xfSsl.toLowerCase() === 'on') return 'https';
  const cfVisitor = String(req.headers['cf-visitor'] || '').trim();
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      if (parsed && parsed.scheme) return String(parsed.scheme);
    } catch (e) {}
  }
  return '';
}

function getBaseUrlFromRequest(req) {
  if (DOMAIN && DOMAIN !== 'localhost') {
    return `https://${DOMAIN}`;
  }
  const host = String(
    req.headers['cf-connecting-host'] ||
    req.headers['x-forwarded-host'] ||
    req.headers.host ||
    ''
  ).trim();
  const proto = getForwardedProto(req) || req.protocol;
  if (host) {
    const hostnameOnly = host.split(':')[0];
    if (!isLocalHostName(hostnameOnly)) {
      const scheme = (proto || 'http') === 'http' ? 'https' : (proto || 'https');
      return `${scheme}://${host}`;
    }
  }
  return DEFAULT_BASE_URL;
}

function getBaseOrigin(req) {
  return new URL(getBaseUrlFromRequest(req)).origin;
}

function encodeBase64Url(value) {
  return Buffer.from(String(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function shouldForceWsTunnelUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  if (!rawUrl) return false;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    return FORCED_WS_TUNNEL_RULES.some((rule) => (
      resolved.origin === rule.origin &&
      resolved.pathname.startsWith(rule.pathPrefix)
    ));
  } catch (e) {
    return false;
  }
}

function isGeneratedImageAssetUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  if (!rawUrl) return false;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    return (
      resolved.origin === 'https://lh3.googleusercontent.com' &&
      (
        resolved.pathname.startsWith('/gg/') ||
        resolved.pathname.startsWith('/gg-dl/') ||
        resolved.pathname.startsWith('/rd-gg-dl/')
      )
    ) || (
      resolved.origin === 'https://work.fife.usercontent.google.com' &&
      resolved.pathname.startsWith('/rd-gg-dl/')
    );
  } catch (e) {
    return false;
  }
}

function shouldServeGeneratedImageHtml(req, targetUrl, baseUrl = DEFAULT_BASE_URL) {
  if (!isGeneratedImageAssetUrl(targetUrl, baseUrl)) return false;
  if (req.query && (req.query.raw === '1' || req.query.proxy_raw === '1')) return false;

  const accept = String(req.headers.accept || '').toLowerCase();
  const secFetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();

  return (
    accept.includes('text/html') ||
    secFetchDest === 'document' ||
    secFetchDest === 'iframe' ||
    secFetchMode === 'navigate'
  );
}

function renderGeneratedImageHtml(targetUrl, baseUrl) {
  const proxiedImageUrl = `${baseUrl}/__proxy/${encodeBase64Url(targetUrl)}?raw=1`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Gemini Image</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle at top, rgba(95, 148, 255, 0.18), transparent 38%),
        radial-gradient(circle at bottom, rgba(0, 194, 168, 0.14), transparent 42%),
        #0b0d12;
      color: #eef2ff;
      font-family: "Segoe UI", system-ui, sans-serif;
    }
    .shell {
      width: min(100vw, 1200px);
      padding: 20px;
    }
    .panel {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 20px;
      background: rgba(11,13,18,0.82);
      box-shadow: 0 24px 80px rgba(0,0,0,0.35);
      overflow: hidden;
      backdrop-filter: blur(14px);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .title {
      font-size: 14px;
      color: rgba(238,242,255,0.78);
      word-break: break-all;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .button {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      padding: 10px 14px;
      color: #f8fafc;
      background: rgba(255,255,255,0.06);
      text-decoration: none;
      font-size: 13px;
    }
    .stage {
      min-height: 70vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 22px;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 160px);
      border-radius: 14px;
      background: rgba(255,255,255,0.03);
    }
    .hint {
      padding: 0 18px 18px;
      font-size: 13px;
      color: rgba(226,232,240,0.76);
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="panel">
      <div class="toolbar">
        <div class="title">${escapeHtml(targetUrl)}</div>
        <div class="actions">
          <a class="button" href="${escapeHtml(proxiedImageUrl)}">Raw proxy</a>
          <a class="button" href="${escapeHtml(targetUrl)}" rel="noreferrer noopener" target="_blank">Open direct</a>
        </div>
      </div>
      <div class="stage">
        <img id="preview" alt="Gemini generated image" referrerpolicy="no-referrer" src="${escapeHtml(targetUrl)}">
      </div>
      <div class="hint" id="hint">Vista HTML local para imágenes generadas. Si la carga directa falla, se intenta el asset proxied.</div>
    </section>
  </main>
  <script>
    (function () {
      var preview = document.getElementById('preview');
      var hint = document.getElementById('hint');
      var directUrl = ${JSON.stringify(targetUrl)};
      var proxiedUrl = ${JSON.stringify(proxiedImageUrl)};
      var triedProxy = false;
      preview.addEventListener('error', function () {
        if (!triedProxy) {
          triedProxy = true;
          hint.textContent = 'La carga directa falló; intentando la versión proxied.';
          preview.src = proxiedUrl;
          return;
        }
        hint.textContent = 'La imagen fue rechazada tanto en carga directa como proxied.';
      });
      preview.addEventListener('load', function () {
        var source = preview.currentSrc || preview.src || '';
        hint.textContent = source === directUrl
          ? 'Imagen cargada desde la URL original.'
          : 'Imagen cargada desde el proxy local.';
      });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function validateToken(token) {
  try {
    const url = `${JALL_API_URL}/user-accounts/validate-token?token=${encodeURIComponent(token)}`;
    console.log(`[AUTH:DEBUG] validateToken -> URL: ${url}`);
    console.log(`[AUTH:DEBUG] token recibido: ${token ? token.substring(0, 30) + '...' : 'NULO/VACÍO'}`);

    // Decodifica el payload del JWT sin verificar firma (solo para diagnóstico)
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const expDate = new Date(payload.exp * 1000);
        const nowDate = new Date();
        console.log(`[AUTH:DEBUG] JWT payload: userId=${payload.userId}, email=${payload.email}`);
        console.log(`[AUTH:DEBUG] JWT exp: ${expDate.toISOString()} | ahora: ${nowDate.toISOString()} | expirado: ${nowDate > expDate}`);
      }
    } catch (decodeErr) {
      console.log(`[AUTH:DEBUG] no se pudo decodificar el JWT: ${decodeErr.message}`);
    }

    const response = await fetch(url, {
      headers: {
        accept: 'application/json'
      }
    });
    console.log(`[AUTH:DEBUG] respuesta de la API: status=${response.status} ok=${response.ok}`);
    const responseText = await response.text();

    if (!response.ok) {
      const body = responseText || '(no body)';
      console.log(`[AUTH:DEBUG] API respondió NO-OK. Body: ${body}`);
      return { valid: false };
    }

    let data;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch (parseErr) {
      const contentType = String(response.headers.get('content-type') || '');
      console.log(`[AUTH:DEBUG] respuesta no JSON. content-type=${contentType} body=${responseText.slice(0, 300)}`);
      logLine(`[AUTH] token validation non-json response: ${contentType || 'unknown content-type'}`);
      return { valid: false };
    }

    if (!data || typeof data !== 'object') {
      console.log(`[AUTH:DEBUG] respuesta vacia o invalida de la API: ${responseText.slice(0, 300)}`);
      logLine('[AUTH] token validation empty response');
      return { valid: false };
    }
    console.log(`[AUTH:DEBUG] respuesta JSON de la API:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.log(`[AUTH:DEBUG] EXCEPCIÓN en validateToken: ${e && e.message ? e.message : String(e)}`);
    logLine(`[AUTH] token validation failed: ${e && e.message ? e.message : String(e)}`);
    return { valid: false };
  }
}

function getAuthTokenFromRequest(req) {
  if (req.query.token) {
    return req.query.token;
  }

  const rawCookieHeader = String(req.headers.cookie || '');
  if (!rawCookieHeader) {
    return '';
  }

  const tokenCookie = rawCookieHeader
    .split(';')
    .map((cookiePart) => cookiePart.trim())
    .find((cookiePart) => cookiePart.startsWith('jall_token='));

  if (!tokenCookie) {
    return '';
  }

  return tokenCookie.slice('jall_token='.length).trim();
}

function isHtmlNavigationRequest(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const secFetchDest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  const secFetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();

  return (
    req.path === '/' ||
    req.path === '/app' ||
    accept.includes('text/html') ||
    secFetchDest === 'document' ||
    secFetchDest === 'iframe' ||
    secFetchMode === 'navigate'
  );
}

function isPublicProxyRoute(req) {
  if (req.method === 'OPTIONS') return true;

  return [
    '/health',
    '/client-log',
    '/log.txt',
    '/logger.js',
    '/sw.js',
    '/sw-register.js',
    '/favicon.ico'
  ].includes(req.path);
}

function renderMissingTokenPage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Acceso Denegado</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
            body {
                background-color: #121212;
                color: #e0e0e0;
                font-family: 'Roboto', sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
            }
            .card {
                background-color: #1e1e1e;
                border-radius: 12px;
                padding: 40px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                text-align: center;
                max-width: 400px;
                border: 1px solid #333;
            }
            h1 {
                color: #ef5350;
                font-size: 24px;
                margin-bottom: 16px;
            }
            p {
                color: #b0bec5;
                font-size: 16px;
                line-height: 1.5;
                margin-bottom: 32px;
            }
            .btn {
                background-color: #4caf50;
                color: #000;
                padding: 12px 24px;
                border-radius: 24px;
                text-decoration: none;
                font-weight: bold;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                transition: background-color 0.3s;
                display: inline-block;
                box-shadow: 0 0 10px rgba(76, 175, 80, 0.3);
            }
            .btn:hover {
                background-color: #66bb6a;
                box-shadow: 0 0 15px rgba(102, 187, 106, 0.5);
            }
            .icon {
                width: 64px;
                height: 64px;
                color: #ef5350;
                margin-bottom: 16px;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <svg class="icon" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 2C17.5 2 22 6.5 22 12S17.5 22 12 22 2 17.5 2 12 6.5 2 12 2M12 4C7.59 4 4 7.59 4 12S7.59 20 12 20 20 16.41 20 12 16.41 4 12 4M12 16C12.55 16 13 16.45 13 17S12.55 18 12 18 11 17.55 11 17 11.45 16 12 16M11 7H13V14H11V7Z" />
            </svg>
            <h1>Acceso Denegado</h1>
            <p>No se proporcion&oacute; un token de acceso v&aacute;lido. Por favor adquiera una membres&iacute;a para continuar.</p>
            <a href="https://jall.lat" class="btn">Adquirir Membres&iacute;a</a>
        </div>
    </body>
    </html>
  `;
}

function renderInvalidTokenPage() {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>Token Inv&aacute;lido o Expirado</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>
            body {
                background-color: #121212;
                color: #e0e0e0;
                font-family: 'Roboto', sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
            }
            .card {
                background-color: #1e1e1e;
                border-radius: 12px;
                padding: 40px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                text-align: center;
                max-width: 400px;
                border: 1px solid #333;
            }
            h1 {
                color: #66bb6a;
                font-size: 24px;
                margin-bottom: 16px;
            }
            p {
                color: #b0bec5;
                font-size: 16px;
                line-height: 1.5;
                margin-bottom: 32px;
            }
            .btn {
                background-color: #4caf50;
                color: #000;
                padding: 12px 24px;
                border-radius: 24px;
                text-decoration: none;
                font-weight: bold;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                transition: background-color 0.3s;
                display: inline-block;
                box-shadow: 0 0 10px rgba(76, 175, 80, 0.3);
            }
            .btn:hover {
                background-color: #66bb6a;
                box-shadow: 0 0 15px rgba(102, 187, 106, 0.5);
            }
            .icon {
                width: 64px;
                height: 64px;
                color: #ef5350;
                margin-bottom: 16px;
            }
        </style>
    </head>
    <body>
        <div class="card">
            <svg class="icon" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2C6.47,2 2,6.47 2,12C2,17.53 6.47,22 12,22C17.53,22 22,17.53 22,12C22,6.47 17.53,2 12,2M11,7H13V15H11V7M11,17H13V19H11V17Z" />
            </svg>
            <h1>Token Inv&aacute;lido o Expirado</h1>
            <p>Su token de sesion ha expirado o es invalido, por favor obtenga un nuevo token en jall.lat y adquiera el servicio de chatgpt por solo 0.3 el dia</p>
            <a href="https://gpt.jall.lat" class="btn">Renovar Gemini</a>
        </div>
    </body>
    </html>
  `;
}

function shouldUseDirectUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  if (!rawUrl) return false;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    if (shouldForceWsTunnelUrl(resolved.toString(), baseUrl)) {
      return false;
    }
    return (
      resolved.origin === 'https://www.gstatic.com' &&
      resolved.pathname.startsWith('/_/mss/boq-bard-web/_/js')
    ) || (
      resolved.origin === 'https://lh3.googleusercontent.com' &&
      (
        resolved.pathname.startsWith('/ogw/') ||
        resolved.pathname.startsWith('/a/')
      )
    );
  } catch (e) {
    return false;
  }
}

function isStreamGenerateUrl(rawUrl, baseUrl = DEFAULT_BASE_URL) {
  if (!rawUrl) return false;
  try {
    const resolved = new URL(rawUrl, baseUrl);
    return (
      resolved.origin === UPSTREAM_ORIGIN &&
      resolved.pathname.includes('/assistant.lamda.BardFrontendService/StreamGenerate')
    );
  } catch (e) {
    return false;
  }
}

function isRecoverableStreamText(text) {
  return typeof text === 'string' && text.startsWith(`)]}'`) && text.includes('wrb.fr');
}

async function readTextResponse(response, { allowPartial = false } = {}) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    return { text: await response.text(), partial: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        text += decoder.decode(value, { stream: true });
      }
    }

    text += decoder.decode();
    return { text, partial: false };
  } catch (e) {
    try {
      text += decoder.decode();
    } catch (flushError) {}

    if (allowPartial && isRecoverableStreamText(text)) {
      return { text, partial: true };
    }
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch (readerError) {}
  }
}

function toPublicProxyUrl(rawUrl, baseUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const publicBase = new URL(baseUrl || DEFAULT_BASE_URL);
    const resolved = new URL(rawUrl, publicBase.toString());
    if (shouldForceWsTunnelUrl(resolved.toString(), publicBase.toString())) {
      return `${publicBase.origin}/__proxy/${encodeBase64Url(resolved.toString())}`;
    }
    if (shouldUseDirectUrl(resolved.toString(), publicBase.toString())) {
      return resolved.toString();
    }
    if (resolved.origin === publicBase.origin) {
      return resolved.toString();
    }
    if (resolved.origin === UPSTREAM_ORIGIN) {
      return `${publicBase.origin}${resolved.pathname}${resolved.search}${resolved.hash}`;
    }
    return `${publicBase.origin}/__proxy/${encodeBase64Url(resolved.toString())}`;
  } catch (e) {
    return rawUrl;
  }
}

function resolveUpstreamUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    const publicBase = new URL(baseUrl || DEFAULT_BASE_URL);
    const resolved = new URL(rawUrl, publicBase.toString());
    if (resolved.origin === publicBase.origin) {
      const decoded = decodeProxyPath(resolved.pathname);
      if (decoded) return decoded;
      const path = resolved.pathname === '/' ? '/app' : resolved.pathname;
      return `${UPSTREAM}${path}${resolved.search}${resolved.hash}`;
    }
    return resolved.toString();
  } catch (e) {
    return '';
  }
}

function getUpstreamRequestContext(targetUrl, baseUrl, referrer) {
  const fallbackReferrer = `${UPSTREAM}/`;
  try {
    const target = new URL(targetUrl);
    if (isGeneratedImageAssetUrl(target.toString(), baseUrl)) {
      return {
        origin: '',
        referer: fallbackReferrer,
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      };
    }
    const resolvedReferrer = resolveUpstreamUrl(referrer, baseUrl);
    if (resolvedReferrer) {
      const referrerUrl = new URL(resolvedReferrer);
      if (target.origin !== referrerUrl.origin) {
        return {
          origin: '',
          referer: fallbackReferrer
        };
      }
      return {
        origin: referrerUrl.origin,
        referer: resolvedReferrer
      };
    }
    if (target.origin !== UPSTREAM_ORIGIN) {
      return {
        origin: '',
        referer: fallbackReferrer
      };
    }
    return {
      origin: target.origin,
      referer: `${target.origin}/`
    };
  } catch (e) {
    return {
      origin: UPSTREAM_ORIGIN,
      referer: fallbackReferrer
    };
  }
}

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws-tunnel' });

let browserContext = null;
let workerPage = null;
let workerReady = false;
let workerLaunchPromise = null;
let workerRestartTimer = null;
let serverListening = false;
let workerHeadless = null;
const logFile = path.join(__dirname, 'log.txt');

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFile(logFile, line, () => {});
}

logLine('server-start');

process.on('uncaughtException', (err) => {
  logLine(`uncaughtException: ${err && err.stack ? err.stack : String(err)}`);
});
process.on('unhandledRejection', (err) => {
  logLine(`unhandledRejection: ${err && err.stack ? err.stack : String(err)}`);
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin || getBaseOrigin(req);
  const reqHeaders = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'content-type, authorization, x-requested-with');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: workerReady && serverListening,
    workerReady,
    workerStarting: !!workerLaunchPromise,
    serverListening,
    workerHeadless
  });
});

app.get('/', (req, res, next) => {
  if (req.path === '/' || req.originalUrl === '/') {
    const queryIndex = req.originalUrl.indexOf('?');
    const search = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    return res.redirect(`/app${search}`);
  }
  return next();
});

app.post('/client-log', (req, res) => {
  const { level, args, url } = req.body || {};
  const safeArgs = Array.isArray(args) ? args.join(' | ') : String(args || '');
  logLine(`client:${level || 'info'} url=${url || ''} msg=${safeArgs}`);
  res.sendStatus(204);
});

app.get('/log.txt', (req, res) => {
  res.sendFile(logFile);
});

app.get('/logger.js', (req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const baseOrigin = getBaseOrigin(req);
  const upstreamOrigin = UPSTREAM_ORIGIN;
  const js = `
(function() {
  var baseOrigin = ${JSON.stringify(baseOrigin)};
  var upstreamOrigin = ${JSON.stringify(upstreamOrigin)};
  function shouldKeepDirectUrl(u) {
    try {
      if (${JSON.stringify(FORCED_WS_TUNNEL_RULES)}.some(function(rule) {
        return u.origin === rule.origin && u.pathname.indexOf(rule.pathPrefix) === 0;
      })) {
        return false;
      }
      return (
        u.origin === 'https://www.gstatic.com' &&
        u.pathname.indexOf('/_/mss/boq-bard-web/_/js') === 0
      ) || (
        u.origin === 'https://lh3.googleusercontent.com' &&
        (
          u.pathname.indexOf('/ogw/') === 0 ||
          u.pathname.indexOf('/a/') === 0
        )
      );
    } catch (e) { return false; }
  }
  function base64UrlEncode(str) {
    try {
      var utf8 = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, p1) {
        return String.fromCharCode('0x' + p1);
      });
      return btoa(utf8).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/,'');
    } catch (e) { return ''; }
  }

  function encodeUrl(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin === baseOrigin) return u.href;
      if (shouldKeepDirectUrl(u)) return u.href;
      if (u.origin === upstreamOrigin) return baseOrigin + u.pathname + u.search + u.hash;
      return baseOrigin + '/__proxy/' + base64UrlEncode(u.href);
    } catch (e) {
      return url;
    }
  }

  function sendLog(level, args) {
    try {
      var payload = JSON.stringify({
        level: level,
        args: (args || []).map(function(a) { return String(a); }),
        url: location.href
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/client-log', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/client-log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          keepalive: true
        });
      }
    } catch (e) {}
  }

  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') {
        if (input.indexOf('/client-log') !== -1) return _fetch.call(this, input, init);
        input = encodeUrl(input);
      } else if (input && input.url) {
        if (String(input.url).indexOf('/client-log') !== -1) return _fetch.call(this, input, init);
        input = new Request(encodeUrl(input.url), input);
      }
    } catch (e) {}
    return _fetch.call(this, input, init);
  };

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    try {
      if (String(url).indexOf('/client-log') === -1) {
        url = encodeUrl(url);
      }
    } catch (e) {}
    return _open.apply(this, [method, url].concat([].slice.call(arguments, 2)));
  };

  var _sendBeacon = navigator.sendBeacon;
  if (_sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try { url = encodeUrl(url); } catch (e) {}
      return _sendBeacon.call(navigator, url, data);
    };
  }

  var _error = console.error;
  console.error = function() {
    try {
      var firstArg = arguments && arguments.length ? String(arguments[0]) : '';
      if (firstArg.indexOf('No ID or name found in config') !== -1) {
        return;
      }
      if (firstArg.indexOf('requestStorageAccessFor: Permission denied') !== -1) {
        return;
      }
      if (firstArg.indexOf('requestStorageAccess: Permission denied') !== -1) {
        return;
      }
    } catch (e) {}
    sendLog('error', [].slice.call(arguments));
    return _error.apply(console, arguments);
  };

  var _warn = console.warn;
  console.warn = function() {
    try {
      var warnMsg = arguments && arguments.length ? String(arguments[0]) : '';
      if (warnMsg.indexOf('was preloaded using link preload but not used') !== -1) {
        return;
      }
      if (warnMsg.indexOf('No ID or name found in config') !== -1) {
        return;
      }
      if (warnMsg.indexOf('requestStorageAccessFor: Permission denied') !== -1) {
        return;
      }
      if (warnMsg.indexOf('requestStorageAccess: Permission denied') !== -1) {
        return;
      }
    } catch (e) {}
    return _warn.apply(console, arguments);
  };

  try {
    var grantStorageAccess = function() { return Promise.resolve(); };
    if (typeof document.requestStorageAccessFor === 'function') {
      document.requestStorageAccessFor = grantStorageAccess;
    } else if (typeof Document !== 'undefined' && Document.prototype && typeof Document.prototype.requestStorageAccessFor === 'function') {
      Document.prototype.requestStorageAccessFor = grantStorageAccess;
    }
    if (typeof document.requestStorageAccess === 'function') {
      document.requestStorageAccess = grantStorageAccess;
    } else if (typeof Document !== 'undefined' && Document.prototype && typeof Document.prototype.requestStorageAccess === 'function') {
      Document.prototype.requestStorageAccess = grantStorageAccess;
    }
  } catch (e) {}

  window.addEventListener('error', function(e) {
    sendLog('error', [e.message, e.filename, e.lineno, e.colno]);
  });

  window.addEventListener('unhandledrejection', function(e) {
    sendLog('unhandledrejection', [String(e.reason)]);
  });
})();
  `.trim();
  res.end(js);
});

app.get('/sw.js', (req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const js = `
let wsTunnel = null;
let wsTunnelReady = false;
let pendingRequests = new Map();
let requestIdCounter = 0;
let serverConfig = null;
const upstreamOrigin = ${JSON.stringify(UPSTREAM_ORIGIN)};

function getServerConfig() {
  const origin = self.location.origin;
  const protocol = origin.startsWith('https') ? 'wss' : 'ws';
  const urlObj = new URL(origin);
  const port = urlObj.port || (origin.startsWith('https') ? '443' : '80');
  let wsUrl = ${JSON.stringify(WS_URL)} || \`\${protocol}://\${urlObj.hostname}\${origin.startsWith('https') && port === '443' ? '' : \`:\${port}\`}/ws-tunnel\`;
  try {
    const wsParsed = new URL(wsUrl);
    if (!wsParsed.pathname || wsParsed.pathname === '/') {
      wsParsed.pathname = '/ws-tunnel';
      wsUrl = wsParsed.toString();
    }
  } catch (e) {}
  return Promise.resolve({ serverUrl: origin, wsUrl: wsUrl });
}

function swLog(message) {
  try {
    fetch('/client-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'sw', args: [message], url: self.location.href }),
      keepalive: true
    }).catch(function() {});
  } catch (e) {}
}

function connectTunnel() {
  if (wsTunnel && wsTunnel.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return getServerConfig().then(config => {
    if (!config) {
      const origin = self.location.origin;
      const protocol = origin.startsWith('https') ? 'wss' : 'ws';
      const urlObj = new URL(origin);
      const port = urlObj.port || (origin.startsWith('https') ? '443' : '80');
      const wsUrl = \`\${protocol}://\${urlObj.hostname}\${origin.startsWith('https') && port === '443' ? '' : \`:\${port}\`}/ws-tunnel\`;
      config = { wsUrl: wsUrl, serverUrl: origin };
    }
    serverConfig = config;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.wsUrl);

      ws.onopen = () => {
        wsTunnel = ws;
        wsTunnelReady = true;
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const response = JSON.parse(event.data);
          const { id, status, statusText, headers, bodyBase64, bodyText, error } = response;

          if (pendingRequests.has(id)) {
            const { resolve: resolveRequest, reject: rejectRequest } = pendingRequests.get(id);
            pendingRequests.delete(id);

            if (error) {
              rejectRequest(new Error(error));
            } else {
              let bodyBuffer = null;
              if (bodyBase64) {
                bodyBuffer = Uint8Array.from(atob(bodyBase64), c => c.charCodeAt(0)).buffer;
              }
              const responseBody = [204, 205, 304].includes(status)
                ? null
                : (bodyBuffer || (typeof bodyText === 'string' ? bodyText : null));
              const resHeaders = new Headers(headers || {});
              resHeaders.delete('content-security-policy');
              resHeaders.delete('content-security-policy-report-only');
              resHeaders.delete('x-frame-options');
              resHeaders.delete('permissions-policy');
              resHeaders.delete('origin-trial');
              resHeaders.delete('attribution-reporting-register-source');
              resHeaders.delete('reporting-endpoints');
              resHeaders.delete('document-policy');
              resHeaders.delete('content-encoding');
              resHeaders.delete('content-length');
              resHeaders.delete('transfer-encoding');

              resolveRequest(new Response(responseBody, {
                status: status,
                statusText: statusText,
                headers: resHeaders
              }));
            }
          }
        } catch (e) {
          swLog('Error procesando respuesta WS: ' + e.message);
        }
      };

      ws.onerror = (error) => {
        wsTunnelReady = false;
        swLog('Error WS: ' + (error && error.message ? error.message : String(error)));
        reject(error);
      };

      ws.onclose = () => {
        wsTunnelReady = false;
        wsTunnel = null;
        setTimeout(() => connectTunnel().catch(() => {}), 1000);
      };
    });
  });
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(cacheNames => Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)))),
      connectTunnel()
    ])
  );
});

const PLAY_LOG_PREFIXES = [
  'aHR0cHM6Ly9wbGF5Lmdvb2dsZS5jb20vbG9n',
  'aHR0cDovL3BsYXkuZ29vZ2xlLmNvbS9sb2c'
];

function decodeBase64Url(encoded) {
  if (!encoded) return null;
  const normalized = String(encoded).replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  if (padLen === 1) return null;
  const padded = normalized + (padLen === 2 ? '==' : padLen === 3 ? '=' : '');
  try {
    return decodeURIComponent(escape(atob(padded)));
  } catch (e) {
    try {
      return decodeURIComponent(escape(atob(normalized)));
    } catch (err) {
      return null;
    }
  }
}

function base64UrlEncode(str) {
  try {
    var utf8 = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, p1) {
      return String.fromCharCode('0x' + p1);
    });
    return btoa(utf8).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/,'');
  } catch (e) {
    return '';
  }
}

function shouldIgnoreUrl(urlStr) {
  return String(urlStr || '').indexOf('://play.google.com/log') !== -1;
}

function shouldUseDirectUrl(urlStr) {
  try {
    var parsed = new URL(urlStr);
    if (${JSON.stringify(FORCED_WS_TUNNEL_RULES)}.some(function(rule) {
      return parsed.origin === rule.origin && parsed.pathname.indexOf(rule.pathPrefix) === 0;
    })) {
      return false;
    }
    return (
      parsed.origin === 'https://www.gstatic.com' &&
      parsed.pathname.indexOf('/_/mss/boq-bard-web/_/js') === 0
    ) || (
      parsed.origin === 'https://lh3.googleusercontent.com' &&
      (
        parsed.pathname.indexOf('/ogw/') === 0 ||
        parsed.pathname.indexOf('/a/') === 0
      )
    );
  } catch (e) {
    return false;
  }
}

function isHttpRequest(url) {
  return url && (url.protocol === 'http:' || url.protocol === 'https:');
}

function isBypassRequest(url, origin) {
  return url.origin === origin && (
    url.pathname.startsWith('/client-log') ||
    url.pathname.startsWith('/log.txt') ||
    url.pathname.startsWith('/logger.js') ||
    url.pathname.startsWith('/sw.js') ||
    url.pathname.startsWith('/sw-register.js') ||
    url.pathname.startsWith('/ws-tunnel')
  );
}

function resolveTargetUrl(requestUrl, origin) {
  const url = new URL(requestUrl);
  if (url.origin === origin && url.pathname.startsWith('/__proxy/')) {
    const encoded = url.pathname.replace('/__proxy/', '').split('?')[0];
    if (PLAY_LOG_PREFIXES.some(function(prefix) { return encoded.startsWith(prefix); })) {
      return '__PLAY_LOG__';
    }
    return decodeBase64Url(encoded) || '${UPSTREAM}/app';
  }
  if (url.origin === origin) {
    const path = url.pathname === '/' ? '/app' : url.pathname;
    return '${UPSTREAM}' + path + url.search + url.hash;
  }
  return url.toString();
}

function toProxyVisibleUrl(requestUrl, origin) {
  try {
    const url = new URL(requestUrl);
    if (url.origin === origin) return url.toString();
    if (url.origin === upstreamOrigin) {
      return origin + url.pathname + url.search + url.hash;
    }
    return origin + '/__proxy/' + base64UrlEncode(url.toString());
  } catch (e) {
    return requestUrl;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const origin = serverConfig ? serverConfig.serverUrl : self.location.origin;
  const isBypass = isBypassRequest(url, origin);
  const targetUrl = isHttpRequest(url) ? resolveTargetUrl(event.request.url, origin) : '';

  if (isBypass || !isHttpRequest(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (shouldUseDirectUrl(targetUrl) && (event.request.method === 'GET' || event.request.method === 'HEAD')) {
    if (event.request.url === targetUrl) {
      return;
    }
    event.respondWith(Promise.resolve(Response.redirect(targetUrl, 302)));
    return;
  }

  event.respondWith((async () => {
    try {
      if (targetUrl === '__PLAY_LOG__') {
        const responseHeaders = new Headers({
          'content-type': 'text/plain; charset=utf-8',
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true'
        });
        return new Response(null, { status: 204, headers: responseHeaders });
      }

      if (shouldIgnoreUrl(targetUrl)) {
        const responseHeaders = new Headers({
          'content-type': 'text/plain; charset=utf-8',
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true'
        });
        return new Response(null, { status: 204, headers: responseHeaders });
      }

      if (!wsTunnelReady || !wsTunnel || wsTunnel.readyState !== WebSocket.OPEN) {
        try {
          await connectTunnel();
        } catch (e) {
          swLog('WS connect failed, fallback fetch: ' + (e && e.message ? e.message : String(e)));
          return fetch(event.request);
        }
      }

      let bodyBase64 = null;
      if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
        const clonedRequest = event.request.clone();
        const bodyArrayBuffer = await clonedRequest.arrayBuffer();
        const bodyBytes = new Uint8Array(bodyArrayBuffer);
        let binaryString = '';
        for (let i = 0; i < bodyBytes.length; i += 1) {
          binaryString += String.fromCharCode(bodyBytes[i]);
        }
        bodyBase64 = btoa(binaryString);
      }

      const headers = {};
      event.request.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!['host', 'origin', 'referer', 'content-length', 'connection', 'upgrade'].includes(lowerKey)) {
          headers[key] = value;
        }
      });

      const requestId = ++requestIdCounter;
      const tunnelRequest = {
        id: requestId,
        url: targetUrl,
        baseUrl: origin,
        referrer: event.request.referrer || '',
        method: event.request.method,
        headers: headers,
        bodyBase64: bodyBase64
      };

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('Timeout en túnel WebSocket'));
          }, ${WS_REQUEST_TIMEOUT_MS});

          const originalResolve = resolve;
          const originalReject = reject;
          resolve = (value) => { clearTimeout(timeout); originalResolve(value); };
          reject = (error) => { clearTimeout(timeout); originalReject(error); };

        pendingRequests.set(requestId, { resolve, reject });
        try {
          wsTunnel.send(JSON.stringify(tunnelRequest));
        } catch (e) {
          clearTimeout(timeout);
          pendingRequests.delete(requestId);
          reject(e);
        }
        }).then(response => {
          try {
            swLog('WS response ' + response.status + ' ' + event.request.method + ' ' + toProxyVisibleUrl(event.request.url, origin));
          } catch (e) {}
        const newHeaders = new Headers(response.headers);
        const origin = serverConfig ? serverConfig.serverUrl : self.location.origin;
        newHeaders.set('Access-Control-Allow-Origin', origin);
        newHeaders.set('Access-Control-Allow-Credentials', 'true');
        const responseBody = [204, 205, 304].includes(response.status) ? null : response.body;

        return new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }).catch((err) => {
        try {
          swLog('WS request failed, fallback fetch: ' + (err && err.message ? err.message : String(err)));
        } catch (e) {}
        return fetch(event.request);
      });
    } catch (error) {
      swLog('SW error: ' + error.message);
      const origin = serverConfig ? serverConfig.serverUrl : self.location.origin;
      return new Response(JSON.stringify({
        error: 'Tunel error',
        message: error.message,
        path: url.pathname
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true'
        }
      });
    }
  })());
});
  `.trim();
  res.end(js);
});

app.get('/sw-register.js', (req, res) => {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  const js = `
(function() {
  if (!('serviceWorker' in navigator)) return;
  var reloaded = sessionStorage.getItem('sw-reloaded') === '1';
  navigator.serviceWorker.register('/sw.js?v=${SW_VERSION}', { scope: '/' })
    .then(function() {
      navigator.serviceWorker.ready.then(function() {
        if (!navigator.serviceWorker.controller && !reloaded) {
          sessionStorage.setItem('sw-reloaded', '1');
          location.reload();
        }
      });
    })
    .catch(function() {});

  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (!reloaded) {
      sessionStorage.setItem('sw-reloaded', '1');
      location.reload();
    }
  });
})();
  `.trim();
  res.end(js);
});

app.use(async (req, res, next) => {
  if (isPublicProxyRoute(req) || !isHtmlNavigationRequest(req)) {
    return next();
  }

  const authToken = getAuthTokenFromRequest(req);
  if (!authToken) {
    logLine(`[AUTH] missing token ${req.method} ${req.originalUrl}`);
    return res.status(403).send(renderMissingTokenPage());
  }

  const authData = await validateToken(authToken);
  if (!authData || !authData.valid) {
    logLine(`[AUTH] invalid token ${req.method} ${req.originalUrl}`);
    return res.status(403).send(renderInvalidTokenPage());
  }

  if (req.query.token) {
    res.cookie('jall_token', authToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
  }

  req.authToken = authToken;
  req.authData = authData;
  return next();
});

app.use(async (req, res, next) => {
  if (workerReady && browserContext) {
    return next();
  }

  try {
    await ensureWorkerReady();
  } catch (e) {
    logLine(`workerEnsureError: ${e && e.stack ? e.stack : String(e)}`);
  }

  if (!workerReady || !browserContext) {
    return res.status(503).send('Worker no listo. Abre /health y espera.');
  }
  return next();
});

function markWorkerClosed(reason) {
  workerReady = false;
  browserContext = null;
  workerPage = null;
  logLine(`workerClosed: ${reason}`);
}

function scheduleWorkerRestart(reason) {
  if (workerRestartTimer || workerLaunchPromise) return;
  logLine(`workerRestartScheduled: ${reason}`);
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = null;
    startWorker().catch((err) => {
      logLine(`workerRestartFailed: ${err && err.stack ? err.stack : String(err)}`);
    });
  }, 2000);
}

async function ensureWorkerReady() {
  if (workerReady && browserContext) return browserContext;
  await startWorker();
  return browserContext;
}

async function getCookieHeader(url) {
  await ensureWorkerReady();
  if (!browserContext) {
    throw new Error('Worker context not ready');
  }
  const cookies = await browserContext.cookies(url);
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function sanitizeHeaders(headers) {
  const out = {};
  Object.keys(headers || {}).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if ([
      'host',
      'connection',
      'content-length',
      'accept-encoding',
      'content-encoding',
      'transfer-encoding',
      'upgrade',
      'sec-websocket-key',
      'sec-websocket-protocol',
      'sec-websocket-version',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-storage-access',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'x-proxy-referrer',
      'x-sw-referrer'
    ].includes(lowerKey)) {
      return;
    }
    out[key] = headers[key];
  });
  return out;
}

const PLAY_LOG_PREFIXES = [
  'aHR0cHM6Ly9wbGF5Lmdvb2dsZS5jb20vbG9n',
  'aHR0cDovL3BsYXkuZ29vZ2xlLmNvbS9sb2c'
];

function decodeBase64Url(encoded) {
  if (!encoded) return null;
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  if (padLen === 1) return null;
  const padded = normalized + (padLen === 2 ? '==' : padLen === 3 ? '=' : '');
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (e) {}
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
}

function decodeProxyPath(pathname) {
  if (!pathname.startsWith('/__proxy/')) return null;
  const encoded = pathname.slice('/__proxy/'.length).split('?')[0];
  return decodeBase64Url(encoded);
}

function isPlayLogUrl(urlStr) {
  if (typeof urlStr !== 'string') return false;
  return urlStr.startsWith('https://play.google.com/log') || urlStr.startsWith('http://play.google.com/log');
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBrowserFetchedImageUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === 'https://lh3.googleusercontent.com' &&
      (
        parsed.pathname.startsWith('/gg/') ||
        parsed.pathname.startsWith('/gg-dl/') ||
        parsed.pathname.startsWith('/rd-gg-dl/')
      )
    ) || (
      parsed.origin === 'https://work.fife.usercontent.google.com' &&
      parsed.pathname.startsWith('/rd-gg-dl/')
    );
  } catch (e) {
    return false;
  }
}

async function fetchImageViaWorkerPage(url) {
  await ensureWorkerReady();
  if (!workerPage) {
    throw new Error('Worker page not ready for image fetch');
  }

  const page = workerPage;
  const timeoutMs = 20000;
  const context = page.context();
  const cdp = await context.newCDPSession(page);

  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const imagePromise = new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId = null;
    let lastResponse = null;
    let targetRequestId = null;

    const cleanup = async () => {
      if (timeoutId) clearTimeout(timeoutId);
      try { cdp.off('Network.requestWillBeSent', onRequestWillBeSent); } catch (e) {}
      try { cdp.off('Network.responseReceived', onResponseReceived); } catch (e) {}
      try { cdp.off('Network.loadingFinished', onLoadingFinished); } catch (e) {}
      try { cdp.off('Network.loadingFailed', onLoadingFailed); } catch (e) {}
      try { await cdp.detach(); } catch (e) {}
    };

    const finishResolve = async (value) => {
      if (settled) return;
      settled = true;
      await cleanup();
      resolve(value);
    };

    const finishReject = async (error) => {
      if (settled) return;
      settled = true;
      await cleanup();
      reject(error);
    };

    const onRequestWillBeSent = async (event) => {
      try {
        const request = event && event.request ? event.request : null;
        if (!request) return;
        if (request.url === url && !targetRequestId) {
          targetRequestId = event.requestId;
        }
      } catch (error) {
        await finishReject(error);
      }
    };

    const onResponseReceived = async (event) => {
      try {
        const response = event && event.response ? event.response : null;
        if (!response) return;
        if (!targetRequestId && response.url === url) {
          targetRequestId = event.requestId;
        }
        if (!targetRequestId || event.requestId !== targetRequestId) return;
        const status = Number(response.status || 0);
        lastResponse = {
          url: response.url,
          status,
          statusText: response.statusText || '',
          headers: response.headers || {}
        };
      } catch (error) {
        await finishReject(error);
      }
    };

    const onLoadingFinished = async (event) => {
      try {
        if (!targetRequestId || event.requestId !== targetRequestId || !lastResponse) return;
        if (lastResponse.status >= 300 && lastResponse.status < 400) return;
        const body = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
        await finishResolve({
          status: lastResponse.status,
          statusText: lastResponse.statusText,
          headers: lastResponse.headers,
          bodyBase64: body.base64Encoded ? body.body : Buffer.from(body.body, 'utf8').toString('base64'),
          bodyText: null
        });
      } catch (error) {
        await finishReject(error);
      }
    };

    const onLoadingFailed = async (event) => {
      try {
        if (!targetRequestId || event.requestId !== targetRequestId) return;
        if (lastResponse && lastResponse.status >= 400) {
          await finishResolve({
            status: lastResponse.status,
            statusText: lastResponse.statusText,
            headers: lastResponse.headers,
            bodyBase64: null,
            bodyText: null
          });
          return;
        }
        await finishReject(new Error(`Browser image request failed: ${event && event.errorText ? event.errorText : 'unknown error'}`));
      } catch (error) {
        await finishReject(error);
      }
    };

    cdp.on('Network.requestWillBeSent', onRequestWillBeSent);
    cdp.on('Network.responseReceived', onResponseReceived);
    cdp.on('Network.loadingFinished', onLoadingFinished);
    cdp.on('Network.loadingFailed', onLoadingFailed);

    timeoutId = setTimeout(async () => {
      if (lastResponse && lastResponse.status >= 400) {
        await finishResolve({
          status: lastResponse.status,
          statusText: lastResponse.statusText,
          headers: lastResponse.headers,
          bodyBase64: null,
          bodyText: null
        });
        return;
      }
      await finishReject(new Error(`Browser image request timeout for ${url}`));
    }, timeoutMs);
  });

  const triggerPromise = page.evaluate(async (src) => {
    return new Promise((resolve) => {
      const img = document.createElement('img');
      let done = false;
      let cleanupTimer = null;

      const finish = (value) => {
        if (done) return;
        done = true;
        if (cleanupTimer) clearTimeout(cleanupTimer);
        try {
          img.onload = null;
          img.onerror = null;
          img.removeAttribute('src');
          if (img.parentNode) img.parentNode.removeChild(img);
        } catch (e) {}
        resolve(value);
      };

      img.decoding = 'async';
      img.loading = 'eager';
      img.referrerPolicy = 'strict-origin-when-cross-origin';
      img.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      img.onload = () => finish('load');
      img.onerror = () => finish('error');

      cleanupTimer = setTimeout(() => finish('timeout'), 15000);

      try {
        (document.body || document.documentElement).appendChild(img);
        img.src = src;
      } catch (error) {
        finish(String(error));
      }
    });
  }, url).catch((error) => {
    throw new Error(`Browser image trigger failed: ${error && error.message ? error.message : String(error)}`);
  });

  const result = await imagePromise;
  try {
    await triggerPromise;
  } catch (e) {}

  return result;
}

async function fetchWithSession(url, method, headers, bodyBase64, baseUrl, referrer = '') {
  const origin = new URL(url).origin;
  const cookieHeader = await getCookieHeader(origin);
  const mergedHeaders = sanitizeHeaders(Object.assign({}, headers));
  const requestContext = getUpstreamRequestContext(url, baseUrl, referrer);
  const isGeneratedImageRequest = isGeneratedImageAssetUrl(url, baseUrl);
  const isStreamGenerateRequest = isStreamGenerateUrl(url, baseUrl);
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;
  if (requestContext.origin) {
    mergedHeaders.origin = requestContext.origin;
  } else {
    delete mergedHeaders.origin;
  }
  if (requestContext.referer) {
    mergedHeaders.referer = requestContext.referer;
  } else {
    delete mergedHeaders.referer;
  }
  if (requestContext.accept && !mergedHeaders.accept) {
    mergedHeaders.accept = requestContext.accept;
  }
  if (isGeneratedImageRequest) {
    delete mergedHeaders.origin;
    mergedHeaders.referer = requestContext.referer || `${UPSTREAM}/`;
    mergedHeaders.accept = mergedHeaders.accept || requestContext.accept || 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
  }
  if (isStreamGenerateRequest) {
    mergedHeaders['accept-encoding'] = 'identity';
  }

  const init = { method, headers: mergedHeaders };
  if (bodyBase64) {
    const binary = Buffer.from(bodyBase64, 'base64');
    init.body = binary;
  }

  if (method === 'GET' && isBrowserFetchedImageUrl(url)) {
    try {
      const browserResult = await fetchImageViaWorkerPage(url);
      logLine(`imageAssetBrowser ${method} ${url} -> ${browserResult.status}`);
      const browserHeaders = Object.assign({}, browserResult.headers);
      delete browserHeaders['content-security-policy'];
      delete browserHeaders['content-security-policy-report-only'];
      delete browserHeaders['x-frame-options'];
      delete browserHeaders['permissions-policy'];
      delete browserHeaders['origin-trial'];
      delete browserHeaders['attribution-reporting-register-source'];
      delete browserHeaders['reporting-endpoints'];
      delete browserHeaders['document-policy'];
      delete browserHeaders['content-encoding'];
      delete browserHeaders['content-length'];
      delete browserHeaders['transfer-encoding'];
      browserHeaders['content-security-policy'] = baseUrl.startsWith('https://')
        ? "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:; upgrade-insecure-requests"
        : "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:";
      return {
        status: browserResult.status,
        statusText: browserResult.statusText,
        headers: browserHeaders,
        bodyBase64: browserResult.bodyBase64,
        bodyText: null
      };
    } catch (browserError) {
      logLine(`imageAssetBrowserError ${method} ${url} ${browserError && browserError.stack ? browserError.stack : String(browserError)}`);
    }
  }

  const response = await fetch(url, init);
  if (isGeneratedImageRequest) {
    logLine(`imageAsset ${method} ${url} -> ${response.status}`);
  }
  const resHeaders = {};
  response.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });

  delete resHeaders['content-security-policy'];
  delete resHeaders['content-security-policy-report-only'];
  delete resHeaders['x-frame-options'];
  delete resHeaders['permissions-policy'];
  delete resHeaders['origin-trial'];
  delete resHeaders['attribution-reporting-register-source'];
  delete resHeaders['reporting-endpoints'];
  delete resHeaders['document-policy'];
  delete resHeaders['content-encoding'];
  delete resHeaders['content-length'];
  delete resHeaders['transfer-encoding'];
  resHeaders['content-security-policy'] = baseUrl.startsWith('https://')
    ? "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:; upgrade-insecure-requests"
    : "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:";

  const contentType = (resHeaders['content-type'] || '').toLowerCase();
  let bodyBase64Out = null;
  let bodyText = null;

  if (contentType.includes('text/html')) {
    const { text: html } = await readTextResponse(response);
    const $ = cheerio.load(html);
    $('head').prepend(`<base href="${baseUrl}/" />`);
    $('head').prepend(`<script src="/hide-google-ui.js"></script>`);
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    if (baseUrl.startsWith('https://')) {
      $('head').prepend(`<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">`);
    }
    $('script[src*="/cdn-cgi/"]').remove();
    $('head').prepend(`<script>
      (function() {
        var baseUrl = ${JSON.stringify(baseUrl)};
        var baseOrigin = (function() {
          try { return new URL(baseUrl).origin; } catch (e) { return location.origin; }
        })();
        function shouldKeepDirectUrl(u) {
          try {
            if (${JSON.stringify(FORCED_WS_TUNNEL_RULES)}.some(function(rule) {
              return u.origin === rule.origin && u.pathname.indexOf(rule.pathPrefix) === 0;
            })) {
              return false;
            }
            return (
              u.origin === 'https://www.gstatic.com' &&
              u.pathname.indexOf('/_/mss/boq-bard-web/_/js') === 0
            ) || (
              u.origin === 'https://lh3.googleusercontent.com' &&
              (
                u.pathname.indexOf('/ogw/') === 0 ||
                u.pathname.indexOf('/a/') === 0
              )
            );
          } catch (e) { return false; }
        }
        function base64UrlEncode(str) {
          try {
            var utf8 = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(_, p1) {
              return String.fromCharCode('0x' + p1);
            });
            return btoa(utf8).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/,'');
          } catch (e) { return ''; }
        }
        function upgradeUrl(u) {
          try {
            return String(u)
              .replace(/http:\\/\\/fonts\\.gstatic\\.com/g, 'https://fonts.gstatic.com')
              .replace(/http:\\/\\/fonts\\.googleapis\\.com/g, 'https://fonts.googleapis.com')
              .replace(/(^|[^:])\\/\\/fonts\\.gstatic\\.com/g, '$1https://fonts.gstatic.com')
              .replace(/(^|[^:])\\/\\/fonts\\.googleapis\\.com/g, '$1https://fonts.googleapis.com')
              .replace(/http:\\/\\/www\\.google\\.com\\/js\\/bg\\//g, 'https://www.google.com/js/bg/')
              .replace(/http:\\/\\/play\\.google\\.com/g, 'https://play.google.com');
          } catch (e) { return u; }
        }
        function encodeUrl(url) {
          try {
            if (typeof url === 'string' && url.indexOf('/__proxy/') === 0) return url;
            var u = new URL(url, location.href);
            if (u.origin === baseOrigin) return upgradeUrl(u.href);
            if (shouldKeepDirectUrl(u)) return upgradeUrl(u.href);
            if (u.origin === ${JSON.stringify(UPSTREAM_ORIGIN)}) {
              return baseOrigin + u.pathname + u.search + u.hash;
            }
            return baseOrigin + '/__proxy/' + base64UrlEncode(u.href);
          } catch (e) {
            return url;
          }
        }
        function upgradeCssText(text) {
          try {
            return String(text)
              .replace(/http:\\/\\/fonts\\.gstatic\\.com/g, 'https://fonts.gstatic.com')
              .replace(/http:\\/\\/fonts\\.googleapis\\.com/g, 'https://fonts.googleapis.com')
              .replace(/(^|[^:])\\/\\/fonts\\.gstatic\\.com/g, '$1https://fonts.gstatic.com')
              .replace(/(^|[^:])\\/\\/fonts\\.googleapis\\.com/g, '$1https://fonts.googleapis.com');
          } catch (e) { return text; }
        }
        function rewriteUrl(u) {
          try {
            return upgradeUrl(String(u))
              .replace(/http:\\/\\/localhost:${PORT}/g, baseUrl)
              .replace(/https:\\/\\/localhost:${PORT}/g, baseUrl)
              .replace(/http:\\/\\/127\\.0\\.0\\.1:${PORT}/g, baseUrl)
              .replace(/https:\\/\\/127\\.0\\.0\\.1:${PORT}/g, baseUrl);
          } catch (e) { return u; }
        }
        var _setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function(name, value) {
          try {
            if ((name === 'src' || name === 'href') && typeof value === 'string') {
              value = encodeUrl(rewriteUrl(value));
            }
          } catch (e) {}
          return _setAttribute.call(this, name, value);
        };
        try {
          var desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
          if (desc && desc.set) {
            Object.defineProperty(HTMLScriptElement.prototype, 'src', {
              get: desc.get,
              set: function(v) { return desc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
          if (imgDesc && imgDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
              get: imgDesc.get,
              set: function(v) { return imgDesc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var linkDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
          if (linkDesc && linkDesc.set) {
            Object.defineProperty(HTMLLinkElement.prototype, 'href', {
              get: linkDesc.get,
              set: function(v) { return linkDesc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var anchorDesc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
          if (anchorDesc && anchorDesc.set) {
            Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
              get: anchorDesc.get,
              set: function(v) { return anchorDesc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var iframeDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
          if (iframeDesc && iframeDesc.set) {
            Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
              get: iframeDesc.get,
              set: function(v) { return iframeDesc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var formActionDesc = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action');
          if (formActionDesc && formActionDesc.set) {
            Object.defineProperty(HTMLFormElement.prototype, 'action', {
              get: formActionDesc.get,
              set: function(v) { return formActionDesc.set.call(this, encodeUrl(rewriteUrl(v))); }
            });
          }
        } catch (e) {}
        try {
          var _insertRule = CSSStyleSheet.prototype.insertRule;
          CSSStyleSheet.prototype.insertRule = function(rule, index) {
            return _insertRule.call(this, upgradeCssText(rule), index);
          };
        } catch (e) {}
        try {
          var _replace = CSSStyleSheet.prototype.replace;
          if (_replace) {
            CSSStyleSheet.prototype.replace = function(text) {
              return _replace.call(this, upgradeCssText(text));
            };
          }
        } catch (e) {}
        try {
          var _replaceSync = CSSStyleSheet.prototype.replaceSync;
          if (_replaceSync) {
            CSSStyleSheet.prototype.replaceSync = function(text) {
              return _replaceSync.call(this, upgradeCssText(text));
            };
          }
        } catch (e) {}
        try {
          var _write = document.write;
          document.write = function(html) {
            return _write.call(document, upgradeUrl(html));
          };
          var _writeln = document.writeln;
          document.writeln = function(html) {
            return _writeln.call(document, upgradeUrl(html));
          };
        } catch (e) {}
        try {
          var styles = document.querySelectorAll('style');
          styles.forEach(function(node) {
            node.textContent = upgradeCssText(node.textContent);
          });
          var obs = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
              m.addedNodes && m.addedNodes.forEach(function(n) {
                if (n && n.nodeType === 1 && n.tagName === 'STYLE') {
                  n.textContent = upgradeCssText(n.textContent);
                }
              });
            });
          });
          obs.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (e) {}
        try {
          var _fetch = window.fetch;
          window.fetch = function(input, init) {
            try {
              if (typeof input === 'string') {
                input = encodeUrl(rewriteUrl(input));
              } else if (input && input.url) {
                input = new Request(encodeUrl(rewriteUrl(input.url)), input);
              }
            } catch (e) {}
            return _fetch.call(this, input, init);
          };
        } catch (e) {}
        try {
          var _open = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url) {
            try { url = encodeUrl(rewriteUrl(url)); } catch (e) {}
            return _open.apply(this, [method, url].concat([].slice.call(arguments, 2)));
          };
        } catch (e) {}
        try {
          var _sendBeacon = navigator.sendBeacon;
          if (_sendBeacon) {
            navigator.sendBeacon = function(url, data) {
              try { url = encodeUrl(rewriteUrl(url)); } catch (e) {}
              return _sendBeacon.call(navigator, url, data);
            };
          }
        } catch (e) {}
        try {
          var _openWindow = window.open;
          if (_openWindow) {
            window.open = function(url) {
              try { if (typeof url === 'string') url = encodeUrl(rewriteUrl(url)); } catch (e) {}
              return _openWindow.apply(window, [url].concat([].slice.call(arguments, 1)));
            };
          }
        } catch (e) {}
        try {
          if (window.Location && Location.prototype) {
            var _locationAssign = Location.prototype.assign;
            if (_locationAssign) {
              Location.prototype.assign = function(url) {
                try { url = encodeUrl(rewriteUrl(url)); } catch (e) {}
                return _locationAssign.call(this, url);
              };
            }
            var _locationReplace = Location.prototype.replace;
            if (_locationReplace) {
              Location.prototype.replace = function(url) {
                try { url = encodeUrl(rewriteUrl(url)); } catch (e) {}
                return _locationReplace.call(this, url);
              };
            }
          }
        } catch (e) {}
        try {
          var _submit = HTMLFormElement.prototype.submit;
          if (_submit) {
            HTMLFormElement.prototype.submit = function() {
              try {
                if (this.action) {
                  this.action = encodeUrl(rewriteUrl(this.action));
                }
              } catch (e) {}
              return _submit.apply(this, arguments);
            };
          }
        } catch (e) {}
        var _replace = history.replaceState;
        history.replaceState = function(state, title, url) {
          return _replace.call(this, state, title, rewriteUrl(url));
        };
        var _push = history.pushState;
        history.pushState = function(state, title, url) {
          return _push.call(this, state, title, rewriteUrl(url));
        };
        function sendLog(level, args) {
          try {
            var payload = JSON.stringify({
              level: level,
              args: (args || []).map(function(a) { return String(a); }),
              url: location.href
            });
            if (navigator.sendBeacon) {
              navigator.sendBeacon('/client-log', new Blob([payload], { type: 'application/json' }));
            } else {
              fetch('/client-log', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: payload,
                keepalive: true
              });
            }
          } catch (e) {}
        }
        var _error = console.error;
        console.error = function() {
          try {
            var firstArg = arguments && arguments.length ? String(arguments[0]) : '';
            if (firstArg.indexOf('No ID or name found in config') !== -1) {
              return;
            }
            if (firstArg.indexOf('requestStorageAccessFor: Permission denied') !== -1) {
              return;
            }
            if (firstArg.indexOf('requestStorageAccess: Permission denied') !== -1) {
              return;
            }
          } catch (e) {}
          sendLog('error', [].slice.call(arguments));
          return _error.apply(console, arguments);
        };
        var _warn = console.warn;
        console.warn = function() {
          try {
            var warnMsg = arguments && arguments.length ? String(arguments[0]) : '';
            if (warnMsg.indexOf('was preloaded using link preload but not used') !== -1) {
              return;
            }
            if (warnMsg.indexOf('No ID or name found in config') !== -1) {
              return;
            }
            if (warnMsg.indexOf('requestStorageAccessFor: Permission denied') !== -1) {
              return;
            }
            if (warnMsg.indexOf('requestStorageAccess: Permission denied') !== -1) {
              return;
            }
          } catch (e) {}
          return _warn.apply(console, arguments);
        };
        try {
          var grantStorageAccess = function() { return Promise.resolve(); };
          if (typeof document.requestStorageAccessFor === 'function') {
            document.requestStorageAccessFor = grantStorageAccess;
          } else if (typeof Document !== 'undefined' && Document.prototype && typeof Document.prototype.requestStorageAccessFor === 'function') {
            Document.prototype.requestStorageAccessFor = grantStorageAccess;
          }
          if (typeof document.requestStorageAccess === 'function') {
            document.requestStorageAccess = grantStorageAccess;
          } else if (typeof Document !== 'undefined' && Document.prototype && typeof Document.prototype.requestStorageAccess === 'function') {
            Document.prototype.requestStorageAccess = grantStorageAccess;
          }
        } catch (e) {}
        window.addEventListener('error', function(e) {
          sendLog('error', [e.message, e.filename, e.lineno, e.colno]);
        });
        window.addEventListener('unhandledrejection', function(e) {
          sendLog('unhandledrejection', [String(e.reason)]);
        });
        if ('serviceWorker' in navigator) {
          var reloaded = sessionStorage.getItem('sw-reloaded') === '1';
          navigator.serviceWorker.register('/sw.js?v=${SW_VERSION}', { scope: '/' })
            .then(function() {
              navigator.serviceWorker.ready.then(function() {
                if (!navigator.serviceWorker.controller && !reloaded) {
                  sessionStorage.setItem('sw-reloaded', '1');
                  location.reload();
                }
              });
            })
            .catch(function() {});

          navigator.serviceWorker.addEventListener('controllerchange', function() {
            if (!reloaded) {
              sessionStorage.setItem('sw-reloaded', '1');
              location.reload();
            }
          });
        }
      })();
    </script>`);

    const rewriteAttr = (attr) => {
      $(`[${attr}]`).each((_, el) => {
        const value = $(el).attr(attr);
        if (!value) return;
        if (/^(https?:)?\/\//i.test(value)) {
          $(el).attr(attr, toPublicProxyUrl(value, baseUrl));
          return;
        }
        if (value.startsWith(UPSTREAM_ORIGIN)) {
          $(el).attr(attr, value.replace(UPSTREAM_ORIGIN, baseUrl));
        } else if (value.startsWith(`http://localhost:${PORT}`)) {
          $(el).attr(attr, value.replace(`http://localhost:${PORT}`, baseUrl));
        } else if (value.startsWith(`http://127.0.0.1:${PORT}`)) {
          $(el).attr(attr, value.replace(`http://127.0.0.1:${PORT}`, baseUrl));
        }
      });
    };
    const rewriteMetaRefresh = () => {
      $('meta[http-equiv]').each((_, el) => {
        const httpEquiv = String($(el).attr('http-equiv') || '').toLowerCase();
        if (httpEquiv !== 'refresh') return;
        const content = $(el).attr('content');
        if (!content) return;
        const rewritten = String(content).replace(/(url=)([^;]+)/i, (_, prefix, refreshUrl) => {
          const trimmed = String(refreshUrl || '').trim().replace(/^['"]|['"]$/g, '');
          if (!trimmed) return `${prefix}${refreshUrl}`;
          return `${prefix}${toPublicProxyUrl(trimmed, baseUrl)}`;
        });
        $(el).attr('content', rewritten);
      });
    };

    rewriteAttr('href');
    rewriteAttr('src');
    rewriteAttr('action');
    rewriteMetaRefresh();

    let outHtml = $.html();
    outHtml = outHtml.replace(new RegExp(escapeRegExp(UPSTREAM_ORIGIN), 'g'), baseUrl);
    outHtml = outHtml.replace(new RegExp(`http://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`);
    outHtml = outHtml.replace(new RegExp(`https://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`);
    outHtml = outHtml.replace(new RegExp(`http://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`);
    outHtml = outHtml.replace(new RegExp(`https://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`);
    outHtml = outHtml.replace(new RegExp(`http://localhost:${PORT}`, 'g'), baseUrl);
    outHtml = outHtml.replace(new RegExp(`http://127.0.0.1:${PORT}`, 'g'), baseUrl);
    outHtml = outHtml.replace(new RegExp(`https://localhost:${PORT}`, 'g'), baseUrl);
    outHtml = outHtml.replace(new RegExp(`https://127.0.0.1:${PORT}`, 'g'), baseUrl);
    outHtml = outHtml.replace(/http:\/\/fonts\.gstatic\.com/g, 'https://fonts.gstatic.com');
    outHtml = outHtml.replace(/http:\/\/www\.gstatic\.com/g, 'https://www.gstatic.com');
    outHtml = outHtml.replace(/http:\/\/fonts\.googleapis\.com/g, 'https://fonts.googleapis.com');
    outHtml = outHtml.replace(/(^|[^:])\/\/fonts\.gstatic\.com/g, '$1https://fonts.gstatic.com');
    outHtml = outHtml.replace(/(^|[^:])\/\/fonts\.googleapis\.com/g, '$1https://fonts.googleapis.com');
    outHtml = outHtml.replace(/http:\/\/www\.google\.com\/js\/bg\//g, 'https://www.google.com/js/bg/');
    outHtml = outHtml.replace(/http:\/\/play\.google\.com/g, 'https://play.google.com');
    if (baseUrl.startsWith('https://')) {
      outHtml = outHtml.replace(/http:\/\//g, 'https://');
    }
    bodyText = outHtml;
    resHeaders['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    resHeaders['pragma'] = 'no-cache';
    resHeaders['expires'] = '0';
  } else if (contentType.includes('text/css')) {
    const { text: css } = await readTextResponse(response);
    bodyText = css
      .replace(/http:\/\/fonts\.gstatic\.com/g, 'https://fonts.gstatic.com')
      .replace(/http:\/\/fonts\.googleapis\.com/g, 'https://fonts.googleapis.com')
      .replace(/(^|[^:])\/\/fonts\.gstatic\.com/g, '$1https://fonts.gstatic.com')
      .replace(/(^|[^:])\/\/fonts\.googleapis\.com/g, '$1https://fonts.googleapis.com')
      .replace(new RegExp(`http://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`https://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`http://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`https://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`http://localhost:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`http://127.0.0.1:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`https://localhost:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`https://127.0.0.1:${PORT}`, 'g'), baseUrl);
  } else if (contentType.includes('javascript') || contentType.includes('application/x-javascript')) {
    const { text: js } = await readTextResponse(response);
    bodyText = js
      .replace(/http:\/\/fonts\.gstatic\.com/g, 'https://fonts.gstatic.com')
      .replace(/http:\/\/fonts\.googleapis\.com/g, 'https://fonts.googleapis.com')
      .replace(/(^|[^:])\/\/fonts\.gstatic\.com/g, '$1https://fonts.gstatic.com')
      .replace(/(^|[^:])\/\/fonts\.googleapis\.com/g, '$1https://fonts.googleapis.com')
      .replace(/http:\/\/www\.google\.com\/js\/bg\//g, 'https://www.google.com/js/bg/')
      .replace(/http:\/\/play\.google\.com/g, 'https://play.google.com')
      .replace(new RegExp(`http://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`https://localhost:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`http://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`https://127.0.0.1:${PORT}/__proxy/`, 'g'), `${baseUrl}/__proxy/`)
      .replace(new RegExp(`http://localhost:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`http://127.0.0.1:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`https://localhost:${PORT}`, 'g'), baseUrl)
      .replace(new RegExp(`https://127.0.0.1:${PORT}`, 'g'), baseUrl);
  } else if (contentType.startsWith('text/') || contentType.includes('json')) {
    const { text, partial } = await readTextResponse(response, { allowPartial: isStreamGenerateRequest });
    bodyText = text;
    if (partial) {
      resHeaders['x-proxy-recovered-stream'] = '1';
      logLine(`streamRecover ${url} chars=${text.length}`);
    }
  } else {
    const arrayBuffer = await response.arrayBuffer();
    bodyBase64Out = Buffer.from(arrayBuffer).toString('base64');
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: resHeaders,
    bodyBase64: bodyBase64Out,
    bodyText
  };
}

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    let requestId = null;
    let requestUrl = '';
    try {
      const msg = JSON.parse(data.toString());
      const { id, url, method, headers, bodyBase64, baseUrl, referrer } = msg || {};
      if (!id || !url) return;
      requestId = id;
      requestUrl = url;
      logLine(`wsReq ${method || 'GET'} ${url}`);
      const resolvedBaseUrl = typeof baseUrl === 'string' && baseUrl ? baseUrl : DEFAULT_BASE_URL;
      const result = await fetchWithSession(url, method || 'GET', headers || {}, bodyBase64 || null, resolvedBaseUrl, referrer || '');
      ws.send(JSON.stringify({ ok: true, id, ...result }));
    } catch (e) {
      logLine(`wsError ${requestUrl} ${e && e.stack ? e.stack : String(e)}`);
      try {
        ws.send(JSON.stringify({ ok: false, id: requestId, error: String(e) }));
      } catch (err) {}
    }
  });
});

app.use(async (req, res) => {
  try {
    const baseUrl = getBaseUrlFromRequest(req);
    if (req.path === '/' || req.path === '/app') {
      logLine(`baseUrl=${baseUrl} host=${req.headers.host || ''} xfhost=${req.headers['x-forwarded-host'] || ''} cfhost=${req.headers['cf-connecting-host'] || ''} xfproto=${req.headers['x-forwarded-proto'] || ''} cfvisitor=${req.headers['cf-visitor'] || ''}`);
    }
  const decoded = decodeProxyPath(req.path);
    let targetUrl = decoded || `${UPSTREAM}${req.originalUrl}`;
  if (!decoded && req.path.startsWith('/__proxy/')) {
    const encoded = req.path.slice('/__proxy/'.length).split('?')[0];
    if (PLAY_LOG_PREFIXES.some((prefix) => encoded.startsWith(prefix))) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-credentials', 'true');
      return res.status(204).end();
    }
  }

    if (req.path === '/' || req.originalUrl === '/') {
      targetUrl = `${UPSTREAM}/app`;
    }

    if (isPlayLogUrl(targetUrl)) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-credentials', 'true');
      return res.status(204).end();
    }

    const rawBody = (req.method !== 'GET' && req.method !== 'HEAD') ? await readRawBody(req) : null;
    const bodyBase64 = rawBody ? rawBody.toString('base64') : null;
    const shouldServeImageHtml = req.method === 'GET' && shouldServeGeneratedImageHtml(req, targetUrl, baseUrl);

    if (shouldServeImageHtml) {
      res.status(200);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('pragma', 'no-cache');
      res.setHeader('expires', '0');
      res.setHeader('access-control-allow-origin', '*');
      return res.send(renderGeneratedImageHtml(targetUrl, baseUrl));
    }

    const headers = sanitizeHeaders(req.headers);
    const requestReferrer = req.headers.referer || req.headers.referrer || '';
    const result = await fetchWithSession(targetUrl, req.method, headers, bodyBase64, baseUrl, requestReferrer);

    res.status(result.status || 200);
    Object.keys(result.headers || {}).forEach((key) => {
      if (['content-length', 'connection'].includes(key.toLowerCase())) return;
      res.setHeader(key, result.headers[key]);
    });
    res.setHeader('content-security-policy', baseUrl.startsWith('https://')
      ? "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:; upgrade-insecure-requests"
      : "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; connect-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline' data: blob:");
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', '*');

    if (result.bodyText !== null && result.bodyText !== undefined) {
      return res.send(result.bodyText);
    }
    if (result.bodyBase64) {
      return res.end(Buffer.from(result.bodyBase64, 'base64'));
    }
    return res.end();
  } catch (e) {
    logLine(`httpProxyError: ${e && e.stack ? e.stack : String(e)}`);
    res.status(502).send('Proxy error');
  }
});

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).toLowerCase().trim();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

const isAdminMode = process.argv.includes('-admin');
const headlessDefault = !isAdminMode;
const isHeadless = parseBooleanEnv(process.env.HEADLESS, headlessDefault);
const sessionPath = path.join(__dirname, 'google-session');
const linuxChromeCandidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium'
].filter(Boolean);
const systemChromePath = process.platform === 'linux'
  ? linuxChromeCandidates.find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch (e) {
        return false;
      }
    })
  : null;
const launchArgs = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-setuid-sandbox']
  : [];
workerHeadless = isHeadless;

async function launchWorkerContext(headlessMode) {
  const launchOptions = {
    headless: headlessMode,
    args: launchArgs,
    viewport: { width: 1280, height: 720 }
  };
  if (systemChromePath) {
    launchOptions.executablePath = systemChromePath;
  }
  return chromium.launchPersistentContext(sessionPath, launchOptions);
}

async function startWorker() {
  if (workerLaunchPromise) return workerLaunchPromise;
  if (workerReady && browserContext) return browserContext;

  workerLaunchPromise = (async () => {
    workerReady = false;
    let context;
    let activeHeadless = isHeadless;

    try {
      context = await launchWorkerContext(activeHeadless);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const shouldFallbackToHeadless = !isHeadless
        && message.includes('Target page, context or browser has been closed');
      if (!shouldFallbackToHeadless) {
        throw error;
      }
      logLine(`workerLaunchFallback: headful failed, retrying headless: ${message}`);
      activeHeadless = true;
      context = await launchWorkerContext(true);
    }

    browserContext = context;
    workerHeadless = activeHeadless;
    context.on('close', () => {
      if (browserContext === context) {
        markWorkerClosed('browser context closed');
        scheduleWorkerRestart('browser context closed');
      }
    });

    const openPages = context.pages().filter((candidate) => {
      try {
        return !candidate.isClosed();
      } catch (e) {
        return false;
      }
    });
    const page = openPages[0] || await context.newPage();
    workerPage = page;
    page.on('close', () => {
      if (workerPage === page) {
        workerPage = null;
        logLine('workerPageClosed');
      }
    });

    await page.goto(UPSTREAM_APP, { waitUntil: 'domcontentloaded' });
    workerReady = true;
    logLine('workerReady');

    if (!serverListening) {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(PORT, HOST, () => {
          server.off('error', onError);
          serverListening = true;
          console.log(`Gemini en ${DEFAULT_BASE_URL} (bind ${HOST}:${PORT})`);
          resolve();
        });
      });
    }

    return context;
  })().catch((error) => {
    markWorkerClosed(`start failed: ${error && error.message ? error.message : String(error)}`);
    scheduleWorkerRestart(`start failed: ${error && error.message ? error.message : String(error)}`);
    throw error;
  }).finally(() => {
    workerLaunchPromise = null;
  });

  return workerLaunchPromise;
}

startWorker();
