import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { config, configProblems } from './config.js';
import { basicAuth } from './auth.js';
import { ClickUpError, getFolder, getList, getListFields, iterateTaskPages } from './clickup.js';
import { writeWorkbook, buildFileName } from './excel.js';

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
const exportCache = new Map(); // chave -> { at, filePath, fileName, taskCount }
const progressByToken = new Map(); // token -> { fetched, total, done, error, at }
const emAndamento = new Map(); // chave -> Promise, para dois cliques não gerarem duas vezes

const MAX_EXPORT_CACHE = 5;
const PROGRESS_TTL_MS = 15 * 60 * 1000;

// Os arquivos são montados em disco, não em memória. Uma pasta com 87 mil
// tarefas passaria de 1,9 GB de pico se fosse acumulada antes de escrever.
const TEMP_DIR = path.join(os.tmpdir(), 'clickup-export');
fs.rmSync(TEMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

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
    // Listas avulsas vindas do ambiente: uma chamada por lista.
    const lists = await Promise.all(config.listIds.map((id) => getList(id)));
    catalog = { id: null, name: config.appTitle, lists };
  } else {
    // Uma chamada só traz a pasta com todas as listas e suas contagens; o
    // recorte de quais aparecem é feito aqui, sem gastar mais requisição.
    catalog = await getFolder(config.folderId);

    if (config.idsPermitidos.length) {
      const porId = new Map(catalog.lists.map((list) => [list.id, list]));
      const escolhidas = config.idsPermitidos.map((id) => porId.get(id)).filter(Boolean);

      const sumidas = config.idsPermitidos.filter((id) => !porId.has(id));
      if (sumidas.length) {
        console.warn(
          `[catálogo] ${sumidas.length} lista(s) de src/listas.js não estão na pasta ${config.folderId}: ${sumidas.join(', ')}`,
        );
      }

      // A ordem de src/listas.js manda, então a tela não depende do orderindex.
      catalog = {
        ...catalog,
        lists: escolhidas.map((list, indice) => ({ ...list, orderindex: indice })),
      };
    }
  }

  folderCache = { at: Date.now(), data: catalog };
  return catalog;
}

function rememberExport(chave, entry) {
  exportCache.set(chave, entry);
  while (exportCache.size > MAX_EXPORT_CACHE) {
    const [maisAntiga, valor] = [...exportCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    exportCache.delete(maisAntiga);

    // Apagar na hora cortaria um download em andamento no meio: alguém pode
    // estar baixando este arquivo agora. Um minuto é folga de sobra.
    setTimeout(() => fsp.unlink(valor.filePath).catch(() => {}), 60_000).unref();
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

/**
 * Gera (ou reaproveita) o .xlsx de um conjunto de listas.
 *
 * As listas chegam já validadas contra o catálogo. Dois cliques na mesma coisa
 * compartilham a mesma geração em vez de dobrar o trabalho na API.
 */
async function gerarExport({ chave, nomeArquivo, lists, token }) {
  const cached = exportCache.get(chave);
  if (cached && Date.now() - cached.at < config.exportCacheSeconds * 1000) {
    setProgress(token, {
      fetched: cached.taskCount,
      total: cached.taskCount,
      done: true,
      cached: true,
    });
    return cached;
  }

  if (emAndamento.has(chave)) return emAndamento.get(chave);

  const trabalho = (async () => {
    const filePath = path.join(TEMP_DIR, `${randomUUID()}.xlsx`);
    const totalPrevisto = lists.reduce((soma, list) => soma + (list.taskCount || 0), 0);
    let jaEscritas = 0;

    setProgress(token, {
      fetched: 0,
      total: totalPrevisto || null,
      listas: lists.length,
      listaAtual: lists[0]?.name || null,
      indice: 1,
      done: false,
      error: null,
    });

    const sheets = [];
    for (const [indice, list] of lists.entries()) {
      sheets.push({
        list,
        fieldDefinitions: await getListFields(list.id).catch(() => []),
        pages: (async function* () {
          setProgress(token, { listaAtual: list.name, indice: indice + 1 });
          for await (const pagina of iterateTaskPages(list.id)) {
            yield pagina;
          }
        })(),
      });
    }

    // Progresso somando TODAS as abas. Guardar só o acumulado da aba atual faria
    // a barra voltar para o começo a cada lista nova.
    const porAba = new Map();

    let resumo;
    try {
      resumo = await writeWorkbook({
        filePath,
        sheets,
        onProgress: ({ list, total }) => {
          porAba.set(list?.id || list?.name, total);
          let soma = 0;
          for (const parcial of porAba.values()) soma += parcial;
          setProgress(token, { fetched: soma });
        },
      });
    } catch (err) {
      // Sem isso, cada exportação que falha no meio deixa um arquivo parcial no
      // disco do container para sempre.
      await fsp.unlink(filePath).catch(() => {});
      throw err;
    }

    jaEscritas = resumo.reduce((soma, aba) => soma + aba.tasks, 0);

    const { size } = await fsp.stat(filePath);
    const entry = { at: Date.now(), filePath, fileName: nomeArquivo, taskCount: jaEscritas, size };
    rememberExport(chave, entry);

    setProgress(token, { done: true, fetched: jaEscritas, total: jaEscritas, taskCount: jaEscritas });
    console.log(
      `[export] ${nomeArquivo}: ${resumo.length} aba(s), ${jaEscritas} tarefas, ${(size / 1048576).toFixed(1)} MB`,
    );

    return entry;
  })();

  emAndamento.set(chave, trabalho);
  try {
    return await trabalho;
  } finally {
    emAndamento.delete(chave);
  }
}

// Uma lista só.
app.get('/api/lists/:listId/export.xlsx', async (req, res, next) => {
  const { listId } = req.params;
  const token = typeof req.query.p === 'string' ? req.query.p.slice(0, 64) : null;

  try {
    // Só exporta listas do escopo configurado — o id vem do cliente e não pode
    // virar uma porta para o resto da conta do ClickUp.
    const catalog = await loadCatalog();
    const list = catalog.lists.find((candidate) => candidate.id === listId);
    if (!list) {
      return res.status(404).json({ error: 'Lista não encontrada no escopo configurado.' });
    }

    const entry = await gerarExport({
      chave: `lista:${listId}`,
      nomeArquivo: buildFileName(list.name),
      lists: [list],
      token,
    });
    return sendWorkbook(res, entry);
  } catch (err) {
    setProgress(token, { done: true, error: err.message });
    return next(err);
  }
});

// A pasta inteira: uma aba por lista, num arquivo só.
app.get('/api/export-all.xlsx', async (req, res, next) => {
  const token = typeof req.query.p === 'string' ? req.query.p.slice(0, 64) : null;

  try {
    const catalog = await loadCatalog();
    const lists = catalog.lists.slice().sort((a, b) => a.orderindex - b.orderindex);
    if (!lists.length) {
      return res.status(404).json({ error: 'Nenhuma lista no escopo configurado.' });
    }

    const entry = await gerarExport({
      chave: 'tudo',
      nomeArquivo: buildFileName(catalog.name || 'tudo'),
      lists,
      token,
    });
    return sendWorkbook(res, entry);
  } catch (err) {
    setProgress(token, { done: true, error: err.message });
    return next(err);
  }
});

function sendWorkbook(res, { filePath, fileName, size }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  if (size) res.setHeader('Content-Length', String(size));

  const stream = fs.createReadStream(filePath);

  // Um stream sem listener de 'error' derruba o processo inteiro: se o arquivo
  // sumir do disco entre a geração e o envio, o container reiniciava.
  stream.on('error', (err) => {
    console.error(`[erro] falha ao ler ${filePath}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Falha ao ler o arquivo gerado.' });
    else res.destroy(err);
  });

  return stream.pipe(res);
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
