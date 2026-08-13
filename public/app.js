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
  concluidas: document.getElementById('concluidas'),
  concluidasEstado: document.getElementById('concluidas-estado'),
  concluidasDetalhe: document.getElementById('concluidas-detalhe'),
};

let allLists = [];

const nf = new Intl.NumberFormat('pt-BR');

/**
 * Os dois modos da caixa "Incluir tarefas concluídas". Marcar ou desmarcar
 * muda o conteúdo do arquivo, então a tela precisa mudar junto — sem isso a
 * caixa parecia não fazer nada, e só o nome do arquivo baixado denunciava a
 * diferença.
 */
const FILTROS = {
  com: {
    estado: 'Todas as tarefas',
    detalhe: 'A planilha vem completa: em aberto e concluídas. Desmarque para deixar as concluídas de fora.',
    botao: 'Baixar Excel',
    botaoTudo: 'Baixar tudo',
    contagem: 'Total da lista no ClickUp. Clique para contar as linhas da planilha.',
    contagemReal: (n) => `${n} tarefas — contagem real, com as concluídas`,
    tudo: (abas, total) => `${abas} abas, ${total} tarefas — um arquivo só`,
  },
  sem: {
    estado: 'Só em aberto',
    detalhe: 'As concluídas ficam de fora e o arquivo sai com “EM ABERTO” no nome — vale para todos os downloads.',
    botao: 'Baixar em aberto',
    botaoTudo: 'Baixar tudo em aberto',
    contagem: 'Total no ClickUp, com as concluídas. Clique para contar só as em aberto.',
    contagemReal: (n) => `${n} tarefas em aberto — contagem real`,
    tudo: (abas, total) => `${abas} abas, só o que está em aberto — de ${total} tarefas no total`,
  },
};

function filtroAtual() {
  return els.concluidas.checked ? FILTROS.com : FILTROS.sem;
}

function modoAtual() {
  return els.concluidas.checked ? 'com' : 'sem';
}

/**
 * Escreve a contagem da linha.
 *
 * O número do ClickUp é o total da lista: não muda com o filtro e não conta
 * subtarefas. Quando existe contagem real para o modo atual — apurada por um
 * download ou por um clique aqui — é ela que aparece, porque é a única que
 * corresponde ao arquivo.
 */
function pintarContagem(count, list) {
  const filtro = filtroAtual();
  const real = list.contado?.[modoAtual()];

  if (typeof real === 'number') {
    count.textContent = nf.format(real);
    count.classList.add('row__count--real');
    count.title = filtro.contagemReal(nf.format(real));
    count.removeAttribute('role');
    count.removeAttribute('tabindex');
    return;
  }

  count.textContent = list.taskCount === null ? '—' : nf.format(list.taskCount);
  count.classList.remove('row__count--real');
  count.title = filtro.contagem;
  count.setAttribute('role', 'button');
  count.setAttribute('tabindex', '0');
}

/** Pede ao servidor a contagem real desta lista no filtro que está valendo. */
async function contar(list, count) {
  if (count.dataset.contando === '1') return;
  const modo = modoAtual();

  count.dataset.contando = '1';
  count.classList.add('row__count--contando');
  count.textContent = 'contando…';

  try {
    const res = await fetch(
      `/api/lists/${encodeURIComponent(list.id)}/contagem?concluidas=${modo === 'com' ? 1 : 0}`,
      { cache: 'no-store' },
    );
    if (!res.ok) throw await erroDe(res);
    const { total } = await res.json();

    list.contado = { ...(list.contado || {}), [modo]: total };
  } catch (err) {
    showError(`${list.name}: ${err.message}`);
  } finally {
    delete count.dataset.contando;
    count.classList.remove('row__count--contando');
    // Repinta pelo modo de AGORA: a caixa pode ter mudado durante a contagem.
    pintarContagem(count, list);
  }
}

function rotuloDe(button) {
  const filtro = filtroAtual();
  return button === els.baixarTudo ? filtro.botaoTudo : filtro.botao;
}

function textoTudo() {
  const filtro = filtroAtual();
  const total = allLists.reduce((soma, list) => soma + (list.taskCount || 0), 0);
  return filtro.tudo(nf.format(allLists.length), nf.format(total));
}

/** Reflete na tela o estado da caixa de concluídas. */
function aplicarFiltro() {
  const filtro = filtroAtual();

  document.body.classList.toggle('filtro-em-aberto', !els.concluidas.checked);
  els.concluidasEstado.textContent = filtro.estado;
  els.concluidasDetalhe.textContent = filtro.detalhe;
  if (allLists.length) els.tudoDetalhe.textContent = textoTudo();

  // Botões em download ficam de fora: o rótulo deles é "Gerando…" e será
  // reposto no fim, já com o filtro que estiver valendo naquele momento.
  for (const button of document.querySelectorAll('.download')) {
    if (!button.disabled) button.textContent = rotuloDe(button);
  }
  // Repinta sem re-renderizar: re-renderizar destruiria os botões que estão no
  // meio de um download.
  const porId = new Map(allLists.map((list) => [list.id, list]));
  for (const row of els.lists.querySelectorAll('.row')) {
    const list = porId.get(row.dataset.listId);
    const count = row.querySelector('.row__count');
    if (list && count && count.dataset.contando !== '1') pintarContagem(count, list);
  }
}

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
  pintarContagem(count, list);
  count.addEventListener('click', () => contar(list, count));
  count.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter' || evento.key === ' ') {
      evento.preventDefault();
      contar(list, count);
    }
  });

  const status = document.createElement('span');
  status.className = 'row__status';

  const button = document.createElement('button');
  button.className = 'download';
  button.type = 'button';
  button.textContent = rotuloDe(button);
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

/**
 * Fetch rejeitado (servidor fora do ar, sem internet) chega como TypeError com
 * mensagem em inglês do navegador ("Failed to fetch"). Os erros do servidor já
 * vêm em português — só o de rede precisa de tradução.
 */
function mensagemDe(err) {
  return err instanceof TypeError
    ? 'Sem conexão com o servidor. Verifique sua internet e tente de novo.'
    : err.message;
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
async function baixar({ url: urlBase, button, status, bar, totalEsperado, nomeFallback, aoLimpar, aoContar }) {
  // Vai na URL, e não como estado do servidor: o arquivo guardado em cache é
  // por filtro, então marcar ou desmarcar a caixa devolve o arquivo certo.
  const url = `${urlBase}?concluidas=${els.concluidas.checked ? 1 : 0}`;
  const token =
    crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // O texto de progresso da pasta ocupa a mesma linha do resumo ("19 abas,
  // 92.513 tarefas"); limpar direto deixava a linha vazia depois do download.
  const limpar = aoLimpar || (() => { status.textContent = ''; });

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
    const { aviso, linhas } = await new Promise((resolve, reject) => {
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
            resolve({ aviso: progresso.aviso || null, linhas: progresso.taskCount ?? null });
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
    // Mostra quantas linhas o arquivo tem de verdade: é o único número que
    // corresponde ao que foi baixado — o da lista não muda com o filtro.
    status.textContent = linhas ? `baixado ✓ · ${nf.format(linhas)} linhas` : 'baixado ✓';
    // O download já percorreu tudo: a contagem da linha passa a mostrar o
    // número real, sem gastar as requisições de uma contagem separada.
    if (typeof linhas === 'number') aoContar?.(linhas);
    if (aviso) showAviso(`${nomeFallback.replace(/\.xlsx$/, '')}: ${aviso}`);
    setTimeout(() => {
      bar.style.width = '0';
      limpar();
    }, 4000);
  } catch (err) {
    bar.style.width = '0';
    status.className += ' row__status--error';
    status.textContent = 'erro';
    showError(`${nomeFallback.replace(/\.xlsx$/, '')}: ${mensagemDe(err)}`);
  } finally {
    clearInterval(poll);
    button.disabled = false;
    // Rótulo do filtro que vale AGORA, não o de quando o download começou: a
    // caixa pode ter sido marcada durante os minutos de geração.
    button.textContent = rotuloDe(button);
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
    aoContar: (linhas) => {
      list.contado = { ...(list.contado || {}), [modoAtual()]: linhas };
      const count = row.querySelector('.row__count');
      if (count) pintarContagem(count, list);
    },
  });
}

/** Traz do servidor as contagens reais já apuradas, sem re-renderizar a tela. */
async function sincronizarContagens() {
  try {
    const res = await fetch('/api/lists', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const porId = new Map((data.lists || []).map((list) => [list.id, list]));
    for (const list of allLists) {
      const novo = porId.get(list.id)?.contado || {};
      // Só os modos que o servidor sabe: `null` é "não contei ainda", e
      // sobrescrever com ele apagaria um número que a tela já tem.
      for (const modo of ['com', 'sem']) {
        if (typeof novo[modo] === 'number') {
          list.contado = { ...(list.contado || {}), [modo]: novo[modo] };
        }
      }
    }
    aplicarFiltro();
  } catch {
    /* cosmético: sem isto o usuário só clica na contagem para ver o número */
  }
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
    aoLimpar: () => {
      els.tudoDetalhe.textContent = textoTudo();
    },
    // Exportar a pasta conta todas as listas de uma vez; puxa esses números
    // para as linhas em vez de deixar cada uma pedir a contagem de novo.
    aoContar: () => sincronizarContagens(),
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
    els.tudoDetalhe.textContent = textoTudo();
    render();
    if (data.stale) {
      showAviso(
        'Não deu para atualizar com o ClickUp agora — mostrando a última versão carregada. Tente de novo em instantes.',
      );
    }
  } catch (err) {
    els.lists.innerHTML = '';
    els.title.textContent = 'Exportar tarefas';
    showError(mensagemDe(err));
  }
}

els.search.addEventListener('input', render);
els.refresh.addEventListener('click', () => loadLists({ force: true }));
els.baixarTudo.addEventListener('click', baixarTudo);
els.concluidas.addEventListener('change', aplicarFiltro);

/** Estado inicial da caixa, definido por CLICKUP_INCLUDE_CLOSED no servidor. */
async function carregarPadrao() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.incluirConcluidasPadrao === 'boolean') {
      els.concluidas.checked = data.incluirConcluidasPadrao;
      aplicarFiltro();
    }
  } catch {
    /* sem resposta, fica o padrão do HTML */
  }
}

aplicarFiltro();
carregarPadrao();
loadLists();
