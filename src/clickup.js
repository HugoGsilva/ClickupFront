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

/**
 * Orçamento de requisições, compartilhado por TODAS as exportações do processo.
 *
 * O token do ClickUp aceita 100 requisições por minuto. Exportar a pasta
 * inteira consome ~950 — ou seja, os 9 minutos já são o orçamento inteiro. Sem
 * isto, alguém clicando em "Baixar Excel" durante um "Baixar tudo" empurrava os
 * dois para 429, e o 429 repetido acabava matando a exportação longa.
 *
 * Em vez de reagir ao 429, o app se mantém abaixo do limite: as chamadas
 * esperam a sua vez numa fila única. Fica um pouco mais lento sob concorrência,
 * e para de falhar.
 */
const LIMITE_POR_MINUTO = (() => {
  // Number('') é 0, e ?? não protege contra string vazia: um valor inválido
  // fazia o teto virar zero, nenhuma chamada jamais passar, e o /health
  // continuar verde — o container ficava vivo e inútil, sem reiniciar.
  const bruto = Number(process.env.CLICKUP_REQS_POR_MINUTO);
  if (Number.isFinite(bruto) && bruto > 0) return bruto;
  if (process.env.CLICKUP_REQS_POR_MINUTO) {
    console.warn(
      `CLICKUP_REQS_POR_MINUTO inválido ("${process.env.CLICKUP_REQS_POR_MINUTO}"): usando 90.`,
    );
  }
  return 90;
})();
const carimbos = [];
let fila = Promise.resolve();

async function aguardarVez() {
  const minhaVez = fila.then(async () => {
    for (;;) {
      const agora = Date.now();
      while (carimbos.length && agora - carimbos[0] > 60_000) carimbos.shift();
      if (carimbos.length < LIMITE_POR_MINUTO) {
        carimbos.push(agora);
        return;
      }
      await sleep(Math.max(50, 60_000 - (agora - carimbos[0])));
    }
  });
  // A fila segue mesmo se esta chamada falhar.
  fila = minhaVez.catch(() => {});
  return minhaVez;
}

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
  //
  // redirect:'error' fecha o único furo da invariante: no modo padrão o fetch
  // segue redirects sozinho, e o destino do segundo salto nunca passaria pelas
  // validações acima. A API do ClickUp não redireciona; se um dia redirecionar,
  // é melhor falhar alto do que sair chamando um endereço não validado.
  return fetch(target, { ...options, method: 'GET', body: undefined, redirect: 'error' });
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

  await aguardarVez();

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

  if (res.status === 429 && attempt < 12) {
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

/**
 * Uma lista específica, quando o app é configurado por CLICKUP_LIST_IDS.
 *
 * Aceita também o id que aparece na URL do ClickUp. A rota /v/l/<id> aponta
 * para a VIEW (a visualização em lista), não para a lista — então, se o id não
 * for de lista, tentamos resolvê-lo como view e seguimos para o pai dela.
 * Assim dá para colar o id direto do link do navegador.
 */
export async function getList(listId) {
  assertId(listId, 'id da lista');

  try {
    return normalizeList(await request(`/list/${listId}`));
  } catch (err) {
    const podeSerView = err instanceof ClickUpError && [400, 404].includes(err.status);
    if (!podeSerView) throw err;

    let paiId;
    try {
      const resposta = await request(`/view/${listId}`);
      paiId = resposta?.view?.parent?.id;
    } catch {
      paiId = null;
    }

    if (!paiId) {
      throw new ClickUpError(
        `"${listId}" não é um id de lista nem de view acessível. Rode "npm run descobrir" para ver os ids disponíveis.`,
        404,
      );
    }

    // Confirma que o pai é mesmo uma lista antes de aceitar (uma view também
    // pode pendurar em pasta, espaço ou time).
    try {
      const lista = normalizeList(await request(`/list/${assertId(paiId, 'id da lista')}`));
      console.log(`[clickup] "${listId}" era o id de uma view; usando a lista ${lista.id} ("${lista.name}").`);
      return lista;
    } catch {
      throw new ClickUpError(
        `"${listId}" é uma view que não pertence a uma lista. Use o id da lista — rode "npm run descobrir".`,
        404,
      );
    }
  }
}

/**
 * Espaços, pastas e listas do time — só para o script de descoberta imprimir os
 * ids. O app em si nunca chama isto: ele fica restrito ao que foi configurado.
 */
export async function getSpaces(teamId) {
  const data = await request(`/team/${assertId(teamId, 'CLICKUP_TEAM_ID')}/space`, { archived: 'false' });
  return data.spaces || [];
}

export async function getFolders(spaceId) {
  const data = await request(`/space/${assertId(spaceId, 'id do espaço')}/folder`, { archived: 'false' });
  return data.folders || [];
}

/** Listas soltas do espaço, que não estão dentro de nenhuma pasta. */
export async function getFolderlessLists(spaceId) {
  const data = await request(`/space/${assertId(spaceId, 'id do espaço')}/list`, { archived: 'false' });
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
  if (!Array.isArray(data.fields)) {
    // Engolir isto fazia as colunas caírem para descoberta por amostra, e o
    // erro aparecia depois como "campo apareceu tarde" — apontando para o
    // lugar errado do problema.
    throw new ClickUpError(
      `Resposta inesperada do ClickUp: definições de campo da lista ${listId} vieram sem "fields".`,
      502,
    );
  }
  return data.fields;
}

/**
 * Busca todas as tarefas da lista, paginando de 100 em 100 até a última página.
 * `onProgress` recebe o total acumulado a cada página.
 */
// Tipos de status que o ClickUp considera terminados. Todo status pertence a
// um destes quatro tipos: open, custom, done e closed.
const TIPOS_CONCLUIDOS = new Set(['done', 'closed']);

/**
 * `include_closed=false` só tira do resultado os status do tipo "closed" — um
 * status do tipo "done" ("Concluído", "Finalizado", "Pago") continua vindo.
 * Como é justamente esse o tipo usado na maioria dos fluxos, desmarcar a caixa
 * parecia não fazer efeito nenhum. Aqui o corte é pelo tipo do status, então
 * vale para os dois casos.
 */
export function tarefaConcluida(task) {
  return TIPOS_CONCLUIDOS.has(String(task?.status?.type || '').toLowerCase());
}

export async function* iterateTaskPages(
  listId,
  // `incluirConcluidas` vem por chamada, não de config: duas exportações
  // simultâneas com filtros diferentes não podem compartilhar estado.
  { signal, maxPages = MAX_PAGES, incluirConcluidas = config.includeClosed } = {},
) {
  assertId(listId, 'id da lista');

  for (let page = 0; page < Math.min(maxPages, MAX_PAGES); page++) {
    if (signal?.aborted) throw new ClickUpError('Exportação cancelada.', 499);

    const data = await request(`/list/${listId}/task`, {
      page,
      archived: config.includeArchived ? 'true' : 'false',
      include_closed: incluirConcluidas ? 'true' : 'false',
      subtasks: config.includeSubtasks ? 'true' : 'false',
    });

    // Um 200 sem o campo `tasks` (proxy, WAF, página de manutenção) era
    // indistinguível de "a lista acabou", e a exportação parava no meio
    // entregando um arquivo truncado. Aqui os dois casos são separados com
    // precisão, sem depender de contagem.
    if (!Array.isArray(data.tasks)) {
      throw new ClickUpError(
        `Resposta inesperada do ClickUp na página ${page} da lista ${listId}: veio sem a lista de tarefas.`,
        502,
      );
    }

    const batch = data.tasks;
    if (batch.length === 0 && page > 0 && !data.last_page) {
      throw new ClickUpError(
        `Página ${page} da lista ${listId} veio vazia sem sinalizar o fim: a exportação ficaria incompleta.`,
        502,
      );
    }

    // O filtro vai só no que é entregue: a paginação continua olhando a página
    // crua, senão uma página inteira de concluídas seria lida como "acabou" e a
    // exportação pararia no meio.
    yield incluirConcluidas ? batch : batch.filter((task) => !tarefaConcluida(task));

    if (data.last_page || batch.length === 0) break;
  }
}

/**
 * Junta todas as páginas numa lista só. Use com parcimônia: uma lista de 17 mil
 * tarefas ocupa ~140 MB só de JSON. A exportação usa iterateTaskPages, que
 * escreve conforme lê; isto aqui serve para amostras e scripts.
 */
export async function fetchAllTasks(listId, { onProgress, signal, maxPages = MAX_PAGES } = {}) {
  const tasks = [];
  for await (const batch of iterateTaskPages(listId, { signal, maxPages })) {
    tasks.push(...batch);
    onProgress?.(tasks.length);
  }
  return tasks;
}
