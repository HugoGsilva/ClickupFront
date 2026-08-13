/**
 * ClickUp falso para testar o app sem token real.
 * Reproduz o formato das respostas usadas pelo app: /folder/:id, /folder/:id/list,
 * /list/:id/field e /list/:id/task (paginado de 100 em 100).
 */
import http from 'node:http';

const OPTION_A = 'aaaa1111-2222-3333-4444-555566667777';
const OPTION_B = 'bbbb1111-2222-3333-4444-555566667777';

export const LISTS = [
  { id: '901', name: 'DIVANEIDE', task_count: 3, orderindex: 0 },
  { id: '902', name: 'ANA CAROLINA', task_count: 250, orderindex: 1 },
  // Devolve uma página vazia no meio, sem last_page: simula 200 do ClickUp sem
  // o campo `tasks` (proxy, WAF, hiccup da API). A exportação não pode entregar
  // um arquivo truncado como se estivesse completo.
  { id: '903', name: 'LISTA QUE TRUNCA', task_count: 250, orderindex: 2 },
  // Tem um campo customizado que só aparece a partir da tarefa 150, fora da
  // primeira página que define as colunas.
  { id: '904', name: 'LISTA CAMPO TARDIO', task_count: 250, orderindex: 3 },
];

export const FIELDS = [
  { id: 'f-cpf', name: 'CPF', type: 'short_text', type_config: {} },
  {
    id: 'f-valor',
    name: 'Valor do Precatório',
    type: 'currency',
    type_config: { currency_type: 'BRL', precision: 2 },
  },
  {
    id: 'f-fase',
    name: 'Fase',
    type: 'drop_down',
    type_config: {
      options: [
        { id: OPTION_A, name: 'Análise', orderindex: 0 },
        { id: OPTION_B, name: 'Pago', orderindex: 1 },
      ],
    },
  },
  { id: 'f-audiencia', name: 'Data da audiência', type: 'date', type_config: { include_time: false } },
  { id: 'f-ok', name: 'Documentos OK', type: 'checkbox', type_config: {} },
  {
    id: 'f-tags',
    name: 'Etiquetas do processo',
    type: 'labels',
    type_config: { options: [{ id: OPTION_A, label: 'Urgente' }, { id: OPTION_B, label: 'Revisar' }] },
  },
  // Botão da interface: não carrega dado e não deve virar coluna.
  { id: 'f-botao', name: 'Botão de ação', type: 'button', type_config: {} },
  // Campo que só aparece nas tarefas, não na definição da lista.
  // Serve para provar que ele mesmo assim vira coluna.
];

function makeTask(listId, listName, index) {
  const customFields = [
    { id: 'f-cpf', name: 'CPF', type: 'short_text', value: `000.000.000-${String(index % 100).padStart(2, '0')}` },
    { id: 'f-valor', name: 'Valor do Precatório', type: 'currency', value: 1234.5 + index },
    { id: 'f-fase', name: 'Fase', type: 'drop_down', value: index % 2 === 0 ? OPTION_A : OPTION_B },
    { id: 'f-audiencia', name: 'Data da audiência', type: 'date', value: String(1_760_000_000_000 + index * 86_400_000) },
    { id: 'f-ok', name: 'Documentos OK', type: 'checkbox', value: index % 3 === 0 ? 'true' : 'false' },
    { id: 'f-tags', name: 'Etiquetas do processo', type: 'labels', value: index % 2 === 0 ? [OPTION_A, OPTION_B] : [] },
  ];

  // Campo herdado, presente só na tarefa.
  if (index === 0) {
    customFields.push({ id: 'f-extra', name: 'Campo herdado', type: 'short_text', value: 'valor solto' });
  }

  return {
    id: `t${listId}-${index}`,
    custom_id: index === 0 ? 'PREC-1' : null,
    name: `Tarefa ${index} — ${listName}`,
    text_content: `Descrição da tarefa ${index}`,
    // Tarefas pares são concluídas. Metade delas com status do tipo "closed" e
    // metade do tipo "done" — como no ClickUp de verdade, onde "Concluído"
    // costuma ser do tipo done e escapa do include_closed=false.
    status: index % 2
      ? { status: 'em andamento', type: 'custom' }
      : { status: 'concluído', type: index % 4 === 0 ? 'closed' : 'done' },
    priority: index % 4 === 0 ? { priority: 'urgent' } : null,
    assignees: [{ username: 'Hugo Silva', email: 'hugo@exemplo.com' }],
    tags: [{ name: 'precatorio' }],
    date_created: String(1_750_000_000_000 + index * 1000),
    date_updated: String(1_755_000_000_000 + index * 1000),
    start_date: null,
    due_date: String(1_770_000_000_000 + index * 86_400_000),
    date_closed: null,
    time_estimate: 3_600_000,
    time_spent: 1_800_000,
    list: { id: listId, name: listName },
    parent: null,
    creator: { username: 'Hugo Silva' },
    url: `https://app.clickup.com/t/t${listId}-${index}`,
    custom_fields: customFields,
  };
}

// Como o incidente real: corpo em texto puro vazando a infra interna do
// ClickUp, não um JSON com "err".
const CORPO_500 =
  'Get "http://publicapi-hierarchy.hierarchy.svc.cluster.local/api/v2/list/x": net/http: timeout awaiting response headers';

export function startFakeClickUp() {
  /** Tudo que o app pediu, para o teste provar que só houve leitura. */
  const requests = [];

  // Instabilidade transitória: contadores por instância do fake.
  let tentativas905 = 0; // /list/905 falha na 1ª chamada e passa nas seguintes
  let chamadasFolderInstavel = 0; // /folder/500-depois passa na 1ª e falha depois

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const url = new URL(req.url, 'http://localhost');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const enviar500 = () => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(CORPO_500);
    };

    if (req.headers.authorization !== 'pk_token_de_teste') {
      return send({ err: 'Token invalid' }, 401);
    }

    // Pasta que sai do ar depois da primeira carga: exercita o catálogo de
    // reserva servido quando "Atualizar" falha.
    if (url.pathname === '/folder/500-depois') {
      chamadasFolderInstavel++;
      if (chamadasFolderInstavel === 1) {
        return send({ id: '500-depois', name: 'Pasta Instável', lists: LISTS });
      }
      return enviar500();
    }

    const folderMatch = /^\/folder\/([^/]+)$/.exec(url.pathname);
    if (folderMatch) {
      return send({ id: folderMatch[1], name: 'Negocios Precatorio', lists: LISTS });
    }

    if (/^\/folder\/[^/]+\/list$/.test(url.pathname)) {
      return send({ lists: LISTS });
    }

    // Views: a rota /v/l/<id> do ClickUp aponta para uma view, e o app resolve
    // o pai dela. "8ckr5gz-2173" é uma view de lista; "vw-de-pasta" pendura
    // numa pasta e não deve virar lista nenhuma.
    const viewMatch = /^\/view\/([^/]+)$/.exec(url.pathname);
    if (viewMatch) {
      if (viewMatch[1] === '8ckr5gz-2173') {
        return send({ view: { id: viewMatch[1], name: 'Lista', parent: { id: '902', type: 6 } } });
      }
      if (viewMatch[1] === 'vw-de-pasta') {
        return send({ view: { id: viewMatch[1], name: 'Pasta', parent: { id: '555', type: 5 } } });
      }
      return send({ err: 'View not found' }, 404);
    }

    // Soluço transitório: 500 na primeira chamada, sucesso nas seguintes.
    // Fora de LISTS de propósito, para não mexer nos testes da pasta.
    if (url.pathname === '/list/905') {
      tentativas905++;
      if (tentativas905 === 1) return enviar500();
      return send({ id: '905', name: 'LISTA INSTÁVEL', task_count: 3, orderindex: 4 });
    }

    // Pane persistente: 500 sempre, para provar a desistência com mensagem
    // amigável. Sem estado — pode ser usada por mais de um teste.
    if (url.pathname === '/list/906') {
      return enviar500();
    }

    const listMatch = /^\/list\/([^/]+)$/.exec(url.pathname);
    if (listMatch) {
      const list = LISTS.find((candidate) => candidate.id === listMatch[1]);
      return list ? send(list) : send({ err: 'List not found' }, 404);
    }

    const fieldMatch = /^\/list\/([^/]+)\/field$/.exec(url.pathname);
    if (fieldMatch) {
      return send({ fields: FIELDS });
    }

    const taskMatch = /^\/list\/([^/]+)\/task$/.exec(url.pathname);
    if (taskMatch) {
      const listId = taskMatch[1];
      const list = LISTS.find((candidate) => candidate.id === listId);
      if (!list) return send({ err: 'List not found' }, 404);

      const page = Number(url.searchParams.get('page') || 0);
      const start = page * 100;

      // Página vazia no meio, sem sinalizar fim.
      if (listId === '903' && page === 1) return send({ tasks: [], last_page: false });

      // Como o ClickUp de verdade: include_closed=false remove só os status do
      // tipo "closed". Os do tipo "done" continuam vindo, e cabe ao app
      // descartá-los — é essa a diferença que fazia a caixa parecer inútil.
      const semConcluidas = url.searchParams.get('include_closed') === 'false';

      const slice = [];
      for (let i = start; i < Math.min(start + 100, list.task_count); i++) {
        const task = makeTask(listId, list.name, i);
        if (listId === '904' && i >= 150) {
          task.custom_fields.push({
            id: 'f-tardio',
            name: 'Campo que aparece tarde',
            type: 'short_text',
            value: `valor-${i}`,
          });
        }
        if (semConcluidas && task.status.type === 'closed') continue;
        slice.push(task);
      }
      return send({ tasks: slice, last_page: start + 100 >= list.task_count });
    }

    return send({ err: 'Route not found' }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}`, requests });
    });
  });
}
