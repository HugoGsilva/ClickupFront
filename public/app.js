'use strict';

const els = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  search: document.getElementById('search'),
  count: document.getElementById('count'),
  lists: document.getElementById('lists'),
  feedback: document.getElementById('feedback'),
  refresh: document.getElementById('refresh'),
};

let allLists = [];

const nf = new Intl.NumberFormat('pt-BR');

function showError(message) {
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
  button.addEventListener('click', () => download(list, { button, status, row }));

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

async function download(list, ui) {
  const { button, status, row } = ui;
  const bar = row.querySelector('.row__progress');
  const token =
    crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  showError('');
  button.disabled = true;
  button.textContent = 'Gerando…';
  status.className = 'row__status';
  status.textContent = 'iniciando…';
  bar.style.width = '2%';

  const poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress/${token}`, { cache: 'no-store' });
      if (!res.ok) return;
      const progress = await res.json();

      if (progress.building) {
        status.textContent = `montando planilha (${nf.format(progress.fetched || 0)} tarefas)`;
        bar.style.width = '97%';
        return;
      }
      if (progress.fetched) {
        const total = progress.total || list.taskCount;
        status.textContent = total
          ? `${nf.format(progress.fetched)} de ~${nf.format(total)} tarefas`
          : `${nf.format(progress.fetched)} tarefas`;
        if (total) bar.style.width = `${Math.min(95, (progress.fetched / total) * 95)}%`;
      }
    } catch {
      /* o polling é só cosmético; falhas nele não afetam o download */
    }
  }, 900);

  try {
    const res = await fetch(`/api/lists/${encodeURIComponent(list.id)}/export.xlsx?p=${token}`, {
      cache: 'no-store',
    });

    if (!res.ok) {
      let message = `Falha ao exportar (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch {
        /* resposta sem JSON */
      }
      throw new Error(message);
    }

    const blob = await res.blob();
    saveBlob(blob, fileNameFrom(res.headers.get('Content-Disposition'), `${list.name}.xlsx`));

    bar.style.width = '100%';
    status.textContent = 'baixado ✓';
    setTimeout(() => {
      bar.style.width = '0';
      status.textContent = '';
    }, 4000);
  } catch (err) {
    bar.style.width = '0';
    status.className = 'row__status row__status--error';
    status.textContent = 'erro';
    showError(`${list.name}: ${err.message}`);
  } finally {
    clearInterval(poll);
    button.disabled = false;
    button.textContent = 'Baixar Excel';
  }
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
    render();
  } catch (err) {
    els.lists.innerHTML = '';
    els.title.textContent = 'Exportar tarefas';
    showError(err.message);
  }
}

els.search.addEventListener('input', render);
els.refresh.addEventListener('click', () => loadLists({ force: true }));

loadLists();
