'use strict';

const els = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  lists: document.getElementById('lists'),
  feedback: document.getElementById('feedback'),
  refresh: document.getElementById('refresh'),
  baixarTudo: document.getElementById('baixar-tudo'),
  tudoDetalhe: document.getElementById('tudo-detalhe'),
  tudoProgresso: document.getElementById('tudo-progresso'),
};

let allLists = [];

const nf = new Intl.NumberFormat('pt-BR');

function showError(message) {
  els.feedback.className = 'feedback';
  els.feedback.textContent = message;
  els.feedback.hidden = !message;
}

/** Aviso: a planilha foi entregue, mas com uma ressalva que vale conferir. */
function showAviso(message) {
  els.feedback.className = 'feedback feedback--aviso';
  els.feedback.textContent = message;
  els.feedback.hidden = !message;
}

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function skeleton() {
  els.lists.innerHTML = '<li class="skeleton"></li>'.repeat(6);
}

function render() {
  const term = normalize(els.search.value.trim());
  const visible = term ? allLists.filter((list) => normalize(list.name).includes(term)) : allLists;

  els.count.textContent = visible.length
    ? `${nf.format(visible.length)} ${visible.length === 1 ? 'lista' : 'listas'}`
    : '';

  if (!visible.length) {
    els.lists.innerHTML = `<li class="empty">${
      allLists.length ? 'Nenhum nome encontrado para essa busca.' : 'Nenhuma lista nesta pasta.'
    }</li>`;
    return;
  }

  els.lists.replaceChildren(...visible.map(rowFor));
}

function rowFor(list) {
  const row = document.createElement('li');
  row.className = 'row';
  row.dataset.listId = list.id;

  const name = document.createElement('span');
  name.className = 'row__name';
  name.textContent = list.name;
  name.title = list.name;

  const count = document.createElement('span');
  count.className = 'row__count';
  count.textContent = list.taskCount === null ? '—' : nf.format(list.taskCount);
  count.title = 'Tarefas na lista';

  const status = document.createElement('span');
  status.className = 'row__status';

  const button = document.createElement('button');
  button.className = 'download';
  button.type = 'button';
  button.textContent = 'Baixar Excel';
  button.addEventListener('click', () => baixarLista(list, { button, status, row }));

  const progress = document.createElement('div');
  progress.className = 'row__progress';

  row.append(name, count, status, button, progress);
  return row;
}

/** Lê o nome do arquivo do cabeçalho Content-Disposition. */
function fileNameFrom(disposition, fallback) {
  if (!disposition) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* cai para o formato simples */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1] : fallback;
}

/** Extrai a mensagem de erro que o servidor manda em JSON. */
async function erroDe(res) {
  try {
    const body = await res.json();
    if (body.error) return new Error(body.error);
  } catch {
    /* resposta sem JSON */
  }
  return new Error(`Falha ao exportar (HTTP ${res.status}).`);
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Baixa um .xlsx acompanhando o progresso do servidor.
 * Serve tanto para uma lista quanto para a pasta inteira — o que muda é a URL,
 * o total esperado e onde o texto de progresso aparece.
 */
async function baixar({ url, button, status, bar, totalEsperado, nomeFallback }) {
  const token =
    crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rotuloOriginal = button.textContent;

  showError('');
  button.disabled = true;
  button.textContent = 'Gerando…';
  status.className = status.className.replace(' row__status--error', '');
  status.textContent = 'iniciando…';
  bar.style.width = '2%';

  const poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress/${token}`, { cache: 'no-store' });
      if (!res.ok) return;
      const progress = await res.json();

      const total = progress.total || totalEsperado;
      const partes = [];

      if (progress.listas > 1 && progress.listaAtual) {
        partes.push(`${progress.listaAtual} (${progress.indice}/${progress.listas})`);
      }
      if (progress.fetched) {
        partes.push(
          total
            ? `${nf.format(progress.fetched)} de ~${nf.format(total)} tarefas`
            : `${nf.format(progress.fetched)} tarefas`,
        );
      }

      if (partes.length) status.textContent = partes.join(' · ');
      if (total && progress.fetched) {
        bar.style.width = `${Math.min(95, (progress.fetched / total) * 95)}%`;
      }
    } catch {
      /* o polling é só cosmético; falhas nele não afetam o download */
    }
  }, 900);

  try {
    const separador = url.includes('?') ? '&' : '?';

    // Passo 1: dispara a geração e recebe 202 na hora. A requisição não fica
    // aberta pelos minutos que a exportação leva, então nenhum proxy no caminho
    // (Cloudflare corta em 100 s) derruba a conexão no meio.
    const inicio = await fetch(`${url}${separador}p=${token}&async=1`, { cache: 'no-store' });
    if (!inicio.ok && inicio.status !== 202) throw await erroDe(inicio);

    // Passo 2: espera terminar, acompanhando pelo progresso.
    const aviso = await new Promise((resolve, reject) => {
      const espera = setInterval(async () => {
        try {
          const res = await fetch(`/api/progress/${token}`, { cache: 'no-store' });
          if (!res.ok) return;
          const progresso = await res.json();
          if (progresso.error) {
            clearInterval(espera);
            reject(new Error(progresso.error));
          } else if (progresso.done) {
            clearInterval(espera);
            resolve(progresso.aviso || null);
          }
        } catch {
          /* erro de rede no polling: tenta de novo no próximo tique */
        }
      }, 1000);
    });

    // Passo 3: o arquivo já está pronto e vem do cache, na hora.
    const res = await fetch(`${url}${separador}p=${token}`, { cache: 'no-store' });
    if (!res.ok) throw await erroDe(res);

    const blob = await res.blob();
    saveBlob(blob, fileNameFrom(res.headers.get('Content-Disposition'), nomeFallback));

    bar.style.width = '100%';
    status.textContent = 'baixado ✓';
    if (aviso) showAviso(`${nomeFallback.replace(/\.xlsx$/, '')}: ${aviso}`);
    setTimeout(() => {
      bar.style.width = '0';
      status.textContent = '';
    }, 4000);
  } catch (err) {
    bar.style.width = '0';
    status.className += ' row__status--error';
    status.textContent = 'erro';
    showError(`${nomeFallback.replace(/\.xlsx$/, '')}: ${err.message}`);
  } finally {
    clearInterval(poll);
    button.disabled = false;
    button.textContent = rotuloOriginal;
  }
}

function baixarLista(list, { button, status, row }) {
  return baixar({
    url: `/api/lists/${encodeURIComponent(list.id)}/export.xlsx`,
    button,
    status,
    bar: row.querySelector('.row__progress'),
    totalEsperado: list.taskCount,
    nomeFallback: `${list.name}.xlsx`,
  });
}

function baixarTudo() {
  const total = allLists.reduce((soma, list) => soma + (list.taskCount || 0), 0);
  return baixar({
    url: '/api/export-all.xlsx',
    button: els.baixarTudo,
    status: els.tudoDetalhe,
    bar: els.tudoProgresso,
    totalEsperado: total,
    nomeFallback: 'clickup.xlsx',
  });
}

async function loadLists({ force = false } = {}) {
  skeleton();
  showError('');
  try {
    const res = await fetch(`/api/lists${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Não foi possível carregar as listas (HTTP ${res.status}).`);
    }
    const data = await res.json();
    allLists = data.lists || [];
    if (data.folder?.name) {
      els.title.textContent = data.folder.name;
      document.title = `${data.folder.name} — Exportar tarefas`;
    }
    const total = allLists.reduce((sum, list) => sum + (list.taskCount || 0), 0);
    els.subtitle.textContent = `${nf.format(allLists.length)} listas · ${nf.format(total)} tarefas no total`;
    els.tudoDetalhe.textContent = `${nf.format(allLists.length)} abas, ${nf.format(total)} tarefas — um arquivo só`;
    render();
  } catch (err) {
    els.lists.innerHTML = '';
    els.title.textContent = 'Exportar tarefas';
    showError(err.message);
  }
}

els.search.addEventListener('input', render);
els.refresh.addEventListener('click', () => loadLists({ force: true }));
els.baixarTudo.addEventListener('click', baixarTudo);

loadLists();
