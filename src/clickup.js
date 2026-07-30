import { config } from './config.js';

const DEFAULT_API = 'https://api.clickup.com/api/v2';

/**
 * O endereço da API só pode ser trocado para um ClickUp falso em 127.0.0.1,
 * usado pelos testes.
 *
 * Sem esse limite, CLICKUP_API_BASE seria um desvio de destino silencioso: a
 * trava do safeFetch compara o alvo com esta mesma constante, então apontá-la
 * para outro host faria a trava aprovar o desvio — e o header Authorization
 * com o token iria junto. Qualquer valor que não seja loopback é ignorado.
 */
export function resolveApiBase(raw = process.env.CLICKUP_API_BASE) {
  if (!raw) return DEFAULT_API;

  let url;
  try {
    url = new URL(raw);
  } catch {
    console.warn(`CLICKUP_API_BASE ignorado: "${raw}" não é uma URL válida.`);
    return DEFAULT_API;
  }

  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!loopback) {
    console.warn(
      `CLICKUP_API_BASE ignorado: só é permitido apontar para 127.0.0.1 (testes), e veio "${url.hostname}". ` +
        'Usando a API oficial do ClickUp.',
    );
    return DEFAULT_API;
  }

  return raw;
}

const API = resolveApiBase();
const MAX_PAGES = 1000; // trava de segurança: 100 mil tarefas por lista

export class ClickUpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ClickUpError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const API_URL = new URL(API);

/**
 * O destino está mesmo dentro da API do ClickUp?
 *
 * Compara a URL JÁ NORMALIZADA, não o texto cru: `startsWith` sobre string
 * aprovaria tanto ".../api/v2/../../outra-coisa" (que o fetch normalizaria
 * depois, num clássico "valida uma coisa, usa outra") quanto o host colado
 * "api.clickup.com/api/v2.dominio-do-atacante.com/...". Aqui a origem precisa
 * bater exatamente e o caminho precisa cair dentro do prefixo, com a barra
 * marcando a fronteira.
 */
export function dentroDaApi(target, apiUrl = API_URL) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (url.origin !== apiUrl.origin) return false;
  if (url.username || url.password) return false;

  const base = apiUrl.pathname.replace(/\/+$/, '');
  return url.pathname === base || url.pathname.startsWith(`${base}/`);
}

/**
 * Ids vindos da configuração ou da API entram no caminho da URL, então não
 * podem conter barra nem ".." — senão um CLICKUP_FOLDER_ID como "../v2/task/x"
 * alcançaria qualquer outro endpoint.
 */
function assertId(valor, nome) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(valor || ''))) {
    throw new ClickUpError(`Bloqueado: ${nome} inválido ("${String(valor).slice(0, 40)}").`, 500);
  }
  return valor;
}

/**
 * Trava de segurança: este app é SOMENTE LEITURA.
 *
 * Exportar não precisa de nada além de GET. Qualquer POST/PUT/DELETE aqui seria
 * um bug ou algo pior — e no ClickUp custaria dados de verdade. Em vez de
 * confiar em "não escrevemos", o cofre fica na camada mais baixa: toda chamada
 * passa por aqui, e só passa GET, sem corpo, para o host da API configurada.
 *
 * Exportada para o teste conseguir provar que a trava funciona.
 */
export function safeFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();

  if (method !== 'GET') {
    throw new ClickUpError(
      `Bloqueado: tentativa de ${method} no ClickUp. Este app é somente leitura — ` +
        'ele não cria, edita nem apaga nada.',
      500,
    );
  }

  if (options.body !== undefined && options.body !== null) {
    throw new ClickUpError('Bloqueado: requisição de leitura não pode ter corpo.', 500);
  }

  const target = String(url);
  if (!dentroDaApi(target)) {
    throw new ClickUpError(`Bloqueado: destino fora da API do ClickUp (${target.slice(0, 60)}).`, 500);
  }

  // As chaves literais vêm DEPOIS do spread de propósito: mesmo que options
  // traga um method, ele é sobrescrito aqui. É a última linha de defesa.
  return fetch(target, { ...options, method: 'GET', body: undefined });
}

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
    res = await safeFetch(url, {
      headers: { Authorization: config.clickupToken, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    // Erro da trava de somente-leitura não é falha de rede: não se repete.
    if (err instanceof ClickUpError) throw err;
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
  const folder = await request(`/folder/${assertId(folderId, 'CLICKUP_FOLDER_ID')}`, {
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
  const data = await request(`/folder/${assertId(folderId, 'CLICKUP_FOLDER_ID')}/list`, {
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
  const data = await request(`/list/${assertId(listId, 'id da lista')}/field`);
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

    const data = await request(`/list/${assertId(listId, 'id da lista')}/task`, {
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
