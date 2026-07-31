import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { config, configProblems } from './config.js';
import { basicAuth } from './auth.js';
import { ClickUpError, getFolder, getList, getListFields, fetchAllTasks } from './clickup.js';
import { buildWorkbook, buildFileName } from './excel.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
// Desligado por padrão: confiar no X-Forwarded-For sem proxy na frente deixa
// qualquer cliente forjar o próprio IP e escapar do freio de força bruta.
app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Sem autenticação: usado pelo healthcheck do Docker/Portainer.
app.get('/health', (req, res) => {
  res.json({ ok: configProblems().length === 0, uptime: Math.round(process.uptime()) });
});

// O middleware é async (o freio de força bruta espera antes de responder) e o
// Express 4 não trata promise rejeitada sozinho.
app.use((req, res, next) => {
  basicAuth(req, res, next).catch(next);
});

// ---------------------------------------------------------------------------
// Caches em memória
// ---------------------------------------------------------------------------
let folderCache = null; // { at, data }
const exportCache = new Map(); // listId -> { at, buffer, fileName, taskCount }
const progressByToken = new Map(); // token -> { fetched, total, done, error, at }

const MAX_EXPORT_CACHE = 5;
const PROGRESS_TTL_MS = 15 * 60 * 1000;

/**
 * O catálogo do que o app mostra: a pasta inteira, ou só as listas configuradas
 * em CLICKUP_LIST_IDS. É ele que também serve de allowlist na exportação — id
 * que não estiver aqui não vira requisição.
 */
async function loadCatalog({ force = false } = {}) {
  const fresh = folderCache && Date.now() - folderCache.at < config.listsCacheSeconds * 1000;
  if (fresh && !force) return folderCache.data;

  let catalog;
  if (config.listIds.length) {
    const lists = await Promise.all(config.listIds.map((id) => getList(id)));
    catalog = { id: null, name: config.appTitle, lists };
  } else {
    catalog = await getFolder(config.folderId);
  }

  folderCache = { at: Date.now(), data: catalog };
  return catalog;
}

function rememberExport(listId, entry) {
  exportCache.set(listId, entry);
  while (exportCache.size > MAX_EXPORT_CACHE) {
    const oldest = [...exportCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    exportCache.delete(oldest[0]);
  }
}

function setProgress(token, patch) {
  if (!token) return;
  const now = Date.now();
  for (const [key, value] of progressByToken) {
    if (now - value.at > PROGRESS_TTL_MS) progressByToken.delete(key);
  }
  progressByToken.set(token, { ...(progressByToken.get(token) || {}), ...patch, at: now });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({ title: config.appTitle, user: req.authenticatedUser });
});

app.get('/api/lists', async (req, res, next) => {
  try {
    const folder = await loadCatalog({ force: req.query.refresh === '1' });
    res.json({
      folder: { id: folder.id, name: folder.name },
      lists: folder.lists
        .slice()
        .sort((a, b) => a.orderindex - b.orderindex)
        .map((list) => ({
          id: list.id,
          name: list.name,
          taskCount: list.taskCount,
          cached: exportCache.has(list.id),
        })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/progress/:token', (req, res) => {
  const progress = progressByToken.get(req.params.token);
  res.json(progress || { fetched: 0, total: null, done: false });
});

app.get('/api/lists/:listId/export.xlsx', async (req, res, next) => {
  const { listId } = req.params;
  const token = typeof req.query.p === 'string' ? req.query.p.slice(0, 64) : null;

  try {
    // Só exporta listas da pasta configurada — o id vem do cliente e não pode
    // virar uma porta para o resto da conta do ClickUp.
    const folder = await loadCatalog();
    const list = folder.lists.find((candidate) => candidate.id === listId);
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada no escopo configurado.' });
    }

    setProgress(token, { fetched: 0, total: list.taskCount, done: false, error: null });

    const cached = exportCache.get(listId);
    if (cached && Date.now() - cached.at < config.exportCacheSeconds * 1000) {
      setProgress(token, { fetched: cached.taskCount, total: cached.taskCount, done: true, cached: true });
      return sendWorkbook(res, cached.buffer, cached.fileName);
    }

    const [fieldDefinitions, tasks] = await Promise.all([
      getListFields(listId).catch(() => []),
      fetchAllTasks(listId, { onProgress: (fetched) => setProgress(token, { fetched }) }),
    ]);

    setProgress(token, { fetched: tasks.length, total: tasks.length, building: true });

    const buffer = await buildWorkbook({ list, tasks, fieldDefinitions });
    const fileName = buildFileName(list.name);

    rememberExport(listId, { at: Date.now(), buffer, fileName, taskCount: tasks.length });
    setProgress(token, { done: true, building: false, taskCount: tasks.length });

    console.log(`[export] ${list.name}: ${tasks.length} tarefas, ${fieldDefinitions.length} campos customizados`);
    return sendWorkbook(res, buffer, fileName);
  } catch (err) {
    setProgress(token, { done: true, error: err.message });
    return next(err);
  }
});

function sendWorkbook(res, buffer, fileName) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('Content-Length', Buffer.byteLength(buffer));
  return res.end(Buffer.from(buffer));
}

app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err instanceof ClickUpError ? err.status || 502 : 500;
  console.error(`[erro ${status}] ${req.method} ${req.path} — ${err.message}`);
  res.status(status).json({ error: err.message || 'Erro inesperado.' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const problems = configProblems();
if (problems.length) {
  console.error('\nConfiguração incompleta:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nDefina as variáveis de ambiente (veja .env.example) e suba o app de novo.\n');
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`ClickUp Export rodando em http://localhost:${config.port}`);
  const escopo = config.listIds.length
    ? `listas: ${config.listIds.join(', ')}`
    : `pasta: ${config.folderId}`;
  console.log(`Escopo — ${escopo} | usuário: ${config.authUser}`);
});
