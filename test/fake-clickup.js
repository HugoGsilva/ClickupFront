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
    name: 'Etiquetas',
    type: 'labels',
    type_config: { options: [{ id: OPTION_A, label: 'Urgente' }, { id: OPTION_B, label: 'Revisar' }] },
  },
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
    { id: 'f-tags', name: 'Etiquetas', type: 'labels', value: index % 2 === 0 ? [OPTION_A, OPTION_B] : [] },
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
    status: { status: index % 2 ? 'em andamento' : 'concluído' },
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

export function startFakeClickUp() {
  /** Tudo que o app pediu, para o teste provar que só houve leitura. */
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    const url = new URL(req.url, 'http://localhost');
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== 'pk_token_de_teste') {
      return send({ err: 'Token invalid' }, 401);
    }

    const folderMatch = /^\/folder\/([^/]+)$/.exec(url.pathname);
    if (folderMatch) {
      return send({ id: folderMatch[1], name: 'Negocios Precatorio', lists: LISTS });
    }

    if (/^\/folder\/[^/]+\/list$/.test(url.pathname)) {
      return send({ lists: LISTS });
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
      const slice = [];
      for (let i = start; i < Math.min(start + 100, list.task_count); i++) {
        slice.push(makeTask(listId, list.name, i));
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
