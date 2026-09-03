'use strict';
/**
 * A small Express-like router built only on Node's `http` module.
 *
 * Supports app.get/post/put/delete('/path/:id', handler), route params,
 * JSON body parsing, and res.json()/res.status(). This exists purely
 * because the sandbox this was built in has no network access to install
 * Express - the route files (routes/*.js) are written against this same
 * `(req, res)` + `next()` shape, so migrating to real Express later is a
 * drop-in swap (see backend/README.md).
 */
const { URL } = require('url');

function pathToRegex(routePath) {
  const paramNames = [];
  const normalized = routePath.replace(/\/+$/, '') || '/';
  const pattern = normalized
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern || '/'}$`), paramNames };
}

class Router {
  constructor() {
    this.routes = []; // { method, path, regex, paramNames, handlers }
    this.middlewares = [];
  }

  use(mw) {
    this.middlewares.push(mw);
  }

  _add(method, routePath, handlers) {
    const { regex, paramNames } = pathToRegex(routePath);
    this.routes.push({ method, path: routePath, regex, paramNames, handlers });
  }

  get(p, ...h) { this._add('GET', p, h); }
  post(p, ...h) { this._add('POST', p, h); }
  put(p, ...h) { this._add('PUT', p, h); }
  delete(p, ...h) { this._add('DELETE', p, h); }

  /** Mount a sub-router under a prefix, preserving its own middlewares. */
  mount(prefix, router) {
    const cleanPrefix = prefix.replace(/\/+$/, '');
    router.routes.forEach((r) => {
      const combinedPath = (cleanPrefix + (r.path === '/' ? '' : r.path)) || '/';
      const { regex, paramNames } = pathToRegex(combinedPath);
      const handlers = [...router.middlewares, ...r.handlers];
      this.routes.push({ method: r.method, path: combinedPath, regex, paramNames, handlers });
    });
  }

  async handle(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    const pathname = decodeURIComponent(parsedUrl.pathname).replace(/\/+$/, '') || '/';

    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => {
      const body = JSON.stringify(obj);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(body);
    };

    // Parse JSON body for methods that may carry one
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      req.body = await parseBody(req);
    } else {
      req.body = {};
    }

    const runMiddlewares = (idx, cb) => {
      if (idx >= this.middlewares.length) return cb();
      this.middlewares[idx](req, res, (err) => {
        if (err) return sendError(res, err);
        runMiddlewares(idx + 1, cb);
      });
    };

    runMiddlewares(0, () => {
      const match = this.routes.find((r) => r.method === req.method && r.regex.test(pathname));
      if (!match) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const values = match.regex.exec(pathname).slice(1);
      req.params = {};
      match.paramNames.forEach((name, i) => { req.params[name] = values[i]; });

      let i = 0;
      const next = (err) => {
        if (err) return sendError(res, err);
        const handler = match.handlers[i++];
        if (!handler) return;
        try {
          const maybePromise = handler(req, res, next);
          if (maybePromise && typeof maybePromise.catch === 'function') {
            maybePromise.catch((err2) => sendError(res, err2));
          }
        } catch (err2) {
          sendError(res, err2);
        }
      };
      next();
    });
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal server error' });
}

module.exports = { Router };
