import { config } from './config.js';

// Sobrescrito apenas nos testes, para apontar para um ClickUp falso.
const API = process.env.CLICKUP_API_BASE || 'https://api.clickup.com/api/v2';
const MAX_PAGES = 1000; // trava de segurança: 100 mil tarefas por lista

export class ClickUpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ClickUpError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chamada à API do ClickUp com retry no rate limit (100 req/min por token).
 * Listas grandes consomem centenas de requisições, então isso não é opcional.
 */
async function request(pathname, params = {}, attempt = 0) {
  const url = new URL(API + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: config.clickupToken, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      return request(pathname, params, attempt + 1);
    }
    throw new ClickUpError(`Falha de rede ao falar com o ClickUp: ${err.message}`, 502);
  }

  if (res.status === 429 && attempt < 6) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const retryAfter = Number(res.headers.get('retry-after'));
    let waitMs = 5000;
    if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) waitMs = Math.max(1000, reset * 1000 - Date.now());
    await sleep(Math.min(waitMs + 500, 65_000));
    return request(pathname, params, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      detail = parsed.err || parsed.error || detail;
    } catch {
      /* corpo não-JSON, mantém o texto cru */
    }
    const message =
      res.status === 401
        ? 'Token do ClickUp inválido ou sem permissão (CLICKUP_TOKEN).'
        : `ClickUp respondeu ${res.status}: ${detail}`;
    throw new ClickUpError(message, res.status);
  }

  return res.json();
}

/** Dados da pasta configurada, já com as listas que ela contém. */
export async function getFolder(folderId) {
  const folder = await request(`/folder/${folderId}`, {
    archived: config.includeArchived ? 'true' : 'false',
  });
  return {
    id: folder.id,
    name: folder.name,
    lists: (folder.lists || []).map(normalizeList),
  };
}

/** Listas da pasta configurada, ordenadas pela ordem definida no ClickUp. */
export async function getLists(folderId) {
  const data = await request(`/folder/${folderId}/list`, {
    archived: config.includeArchived ? 'true' : 'false',
  });
  return (data.lists || []).map(normalizeList);
}

function normalizeList(list) {
  return {
    id: list.id,
    name: list.name,
    taskCount: list.task_count ?? null,
    archived: Boolean(list.archived),
    orderindex: list.orderindex ?? 0,
    folderName: list.folder?.name || null,
    spaceName: list.space?.name || null,
  };
}

/**
 * Definições dos campos customizados acessíveis na lista.
 * Usadas para fixar a ordem e o conjunto de colunas do Excel — assim uma coluna
 * existe mesmo que nenhuma tarefa tenha valor preenchido nela.
 */
export async function getListFields(listId) {
  const data = await request(`/list/${listId}/field`);
  return data.fields || [];
}

/**
 * Busca todas as tarefas da lista, paginando de 100 em 100 até a última página.
 * `onProgress` recebe o total acumulado a cada página.
 */
export async function fetchAllTasks(listId, { onProgress, signal, maxPages = MAX_PAGES } = {}) {
  const tasks = [];

  for (let page = 0; page < Math.min(maxPages, MAX_PAGES); page++) {
    if (signal?.aborted) throw new ClickUpError('Exportação cancelada.', 499);

    const data = await request(`/list/${listId}/task`, {
      page,
      archived: config.includeArchived ? 'true' : 'false',
      include_closed: config.includeClosed ? 'true' : 'false',
      subtasks: config.includeSubtasks ? 'true' : 'false',
    });

    const batch = data.tasks || [];
    tasks.push(...batch);
    onProgress?.(tasks.length);

    if (data.last_page || batch.length === 0) break;
  }

  return tasks;
}
