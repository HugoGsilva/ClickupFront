/**
 * Teste ponta a ponta contra um ClickUp falso:
 * Basic Auth, listagem, geração do .xlsx e conteúdo das colunas.
 *
 * Rodar com: npm test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

import { startFakeClickUp } from './fake-clickup.js';

const USER = 'admin';
const PASSWORD = 'senha-de-teste';
const credentials = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FALHA ${name}\n         ${err.message}`);
  }
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await sleep(200);
  }
  throw new Error(`servidor não subiu em ${url}`);
}

const { server: fake, base, requests } = await startFakeClickUp();
// Também valem para este processo, que importa src/clickup.js direto em alguns testes.
process.env.CLICKUP_API_BASE = base;
process.env.CLICKUP_TOKEN = 'pk_token_de_teste';
const port = 3999;
const appUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: {
    ...process.env,
    CLICKUP_API_BASE: base,
    CLICKUP_TOKEN: 'pk_token_de_teste',
    CLICKUP_FOLDER_ID: '123',
    AUTH_USER: USER,
    AUTH_PASSWORD: PASSWORD,
    PORT: String(port),
    LISTS_CACHE_SECONDS: '0',
    EXPORT_CACHE_SECONDS: '300',
    // Freio de força bruta com números pequenos, para o teste ser rápido.
    AUTH_MAX_FAILURES: '5',
    AUTH_BLOCK_SECONDS: '2',
    AUTH_FAILURE_DELAY_MS: '0',
    UNLINK_DELAY_MS: '50',
    TZ: 'America/Sao_Paulo',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (chunk) => process.stderr.write(`  [app] ${chunk}`));

try {
  await waitForServer(`${appUrl}/health`);
  console.log('\nBasic Auth');

  await test('sem credenciais devolve 401 com WWW-Authenticate', async () => {
    const res = await fetch(`${appUrl}/api/lists`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /^Basic/);
  });

  await test('senha errada devolve 401', async () => {
    const wrong = `Basic ${Buffer.from(`${USER}:errada`).toString('base64')}`;
    const res = await fetch(`${appUrl}/api/lists`, { headers: { Authorization: wrong } });
    assert.equal(res.status, 401);
  });

  await test('a página inicial também é protegida', async () => {
    const res = await fetch(`${appUrl}/`);
    assert.equal(res.status, 401);
  });

  await test('/health responde sem autenticação', async () => {
    const res = await fetch(`${appUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  console.log('\nListagem');

  await test('lista os nomes da pasta com a contagem de tarefas', async () => {
    const res = await fetch(`${appUrl}/api/lists`, { headers: { Authorization: credentials } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.folder.name, 'Negocios Precatorio');
    assert.deepEqual(
      data.lists.map((list) => list.name),
      ['DIVANEIDE', 'ANA CAROLINA', 'LISTA QUE TRUNCA', 'LISTA CAMPO TARDIO'],
    );
    assert.equal(data.lists[1].taskCount, 250);
  });

  await test('lista fora da pasta configurada devolve 404', async () => {
    const res = await fetch(`${appUrl}/api/lists/999/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 404);
  });

  await test('modo CLICKUP_LIST_IDS mostra só as listas configuradas', async () => {
    const outraPorta = 3997;
    const outro = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        CLICKUP_API_BASE: base,
        CLICKUP_TOKEN: 'pk_token_de_teste',
        CLICKUP_FOLDER_ID: '', // sem pasta: só as listas escolhidas
        CLICKUP_LIST_IDS: '902',
        AUTH_USER: USER,
        AUTH_PASSWORD: PASSWORD,
        PORT: String(outraPorta),
        APP_TITLE: 'Listas escolhidas',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
      await waitForServer(`http://127.0.0.1:${outraPorta}/health`);
      const res = await fetch(`http://127.0.0.1:${outraPorta}/api/lists`, {
        headers: { Authorization: credentials },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.lists.map((list) => list.name), ['ANA CAROLINA']);
      assert.equal(data.folder.name, 'Listas escolhidas');

      // A lista de fora continua barrada, como no modo pasta.
      const fora = await fetch(`http://127.0.0.1:${outraPorta}/api/lists/901/export.xlsx`, {
        headers: { Authorization: credentials },
      });
      assert.equal(fora.status, 404);
    } finally {
      outro.kill();
    }
  });

  await test('aceita o id de view que vem na URL do ClickUp', async () => {
    const { getList } = await import('../src/clickup.js');

    // .../v/l/8ckr5gz-2173 → view → lista 902
    const daView = await getList('8ckr5gz-2173');
    assert.equal(daView.id, '902');
    assert.equal(daView.name, 'ANA CAROLINA');

    // id de lista de verdade continua funcionando direto
    const direto = await getList('901');
    assert.equal(direto.name, 'DIVANEIDE');
  });

  await test('view que não pertence a uma lista dá erro explicativo', async () => {
    const { getList } = await import('../src/clickup.js');
    await assert.rejects(() => getList('vw-de-pasta'), /não pertence a uma lista/i);
    await assert.rejects(() => getList('nao-existe-mesmo'), /não é um id de lista nem de view/i);
  });

  console.log('\nExportação');

  let workbook;
  let sheet;

  await test('baixa o .xlsx com nome de arquivo correto', async () => {
    const res = await fetch(`${appUrl}/api/lists/901/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml\.sheet/);
    assert.match(res.headers.get('content-disposition'), /DIVANEIDE_\d{4}-\d{2}-\d{2}\.xlsx/);

    const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
    const file = path.join(dir, 'saida.xlsx');
    await writeFile(file, Buffer.from(await res.arrayBuffer()));

    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    sheet = workbook.worksheets[0];
  });

  await test('a aba tem o nome da lista e uma linha por tarefa', () => {
    assert.equal(sheet.name, 'DIVANEIDE');
    assert.equal(sheet.rowCount, 4); // cabeçalho + 3 tarefas
  });

  await test('as colunas padrão saem com os títulos e na ordem de listas.js', async () => {
    const { COLUNAS } = await import('../src/listas.js');
    const headers = sheet.getRow(1).values.slice(1);

    const titulos = COLUNAS.filter((c) => c.padrao).map((c) => c.titulo);
    const naPlanilha = headers.filter((h) => titulos.includes(h));
    assert.deepEqual(naPlanilha, titulos, 'títulos ou ordem das colunas padrão divergem');
    assert.equal(headers[0], 'Nome da tarefa');

    // Deixadas de fora de propósito.
    for (const fora of ['Prioridade', 'Descrição', 'Link', 'Tarefa pai']) {
      assert.ok(!headers.includes(fora), `"${fora}" não deveria estar na planilha`);
    }
  });

  await test('as duas datas de fim do ClickUp saem em colunas separadas', () => {
    const headers = sheet.getRow(1).values.slice(1);
    const at = (name, row) => sheet.getRow(row).getCell(headers.indexOf(name) + 1).value;

    // date_done e date_closed não coincidem no ClickUp: exportar só uma
    // deixaria a coluna quase vazia nas listas reais.
    assert.ok(headers.includes('Data de conclusão'));
    assert.ok(headers.includes('Data de encerramento'));
    assert.ok(at('Data criada', 2) instanceof Date);
  });

  await test('traz uma coluna por campo customizado, inclusive os herdados', () => {
    const headers = sheet.getRow(1).values.slice(1);
    for (const expected of [
      'CPF',
      'Valor do Precatório',
      'Fase',
      'Data da audiência',
      'Documentos OK',
      'Etiquetas do processo',
      'Campo herdado',
    ]) {
      assert.ok(headers.includes(expected), `faltou o campo customizado "${expected}"`);
    }
  });

  await test('campo customizado fora de COLUNAS entra no fim, não some', async () => {
    const { COLUNAS } = await import('../src/listas.js');
    const headers = sheet.getRow(1).values.slice(1);
    const configurados = new Set(COLUNAS.filter((c) => c.campo).map((c) => c.campo));

    // Os campos do ClickUp falso não estão em COLUNAS (que tem os nomes reais),
    // então precisam aparecer mesmo assim — depois das colunas configuradas.
    const naoConfigurados = ['CPF', 'Fase', 'Campo herdado'];
    for (const nome of naoConfigurados) {
      assert.ok(headers.includes(nome), `"${nome}" sumiu da planilha`);
      assert.ok(!configurados.has(nome), 'o teste pressupõe campo não configurado');
    }

    const ultimoPadrao = Math.max(
      ...COLUNAS.filter((c) => c.padrao).map((c) => headers.indexOf(c.titulo)),
    );
    assert.ok(headers.indexOf('CPF') > ultimoPadrao, 'campo extra deveria vir depois das padrão');
  });

  await test('configuração de coluna inválida é recusada na subida', async () => {
    const { validarColunas } = await import('../src/excel.js');
    const listas = await import('../src/listas.js');
    const original = [...listas.COLUNAS];

    const casos = [
      [{ padrao: 'nao_existe', titulo: 'X' }, /não existe/],
      [{ padrão: 'status', titulo: 'Status' }, /exatamente um/], // acento na propriedade
      [{}, /exatamente um/],
      [{ padrao: 'status', campo: 'CPF' }, /exatamente um/],
      [{ campo: '   ' }, /nome do campo/],
    ];

    try {
      for (const [entrada, esperado] of casos) {
        listas.COLUNAS.length = 0;
        listas.COLUNAS.push(...original, entrada);
        const problemas = validarColunas();
        assert.equal(problemas.length, 1, `${JSON.stringify(entrada)} deveria dar 1 problema`);
        assert.match(problemas[0], esperado);
      }

      listas.COLUNAS.length = 0;
      listas.COLUNAS.push(...original);
      assert.deepEqual(validarColunas(), [], 'a configuração real tem que estar válida');
    } finally {
      listas.COLUNAS.length = 0;
      listas.COLUNAS.push(...original);
    }
  });

  await test('campos homônimos ficam juntos, na posição configurada', async () => {
    const { writeWorkbook } = await import('../src/excel.js');
    const listas = await import('../src/listas.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
    const file = path.join(dir, 'homonimos.xlsx');
    const original = [...listas.COLUNAS];

    // Campo recriado no ClickUp mantém o nome e ganha id novo. Guardar só o
    // último exilava o outro para o fim da aba, com cabeçalho idêntico.
    listas.COLUNAS.length = 0;
    listas.COLUNAS.push({ padrao: 'nome', titulo: 'Nome da tarefa' }, { campo: 'CPF' }, { padrao: 'status', titulo: 'Status' });

    try {
      await writeWorkbook({
        filePath: file,
        sheets: [
          {
            list: { name: 'TESTE' },
            fieldDefinitions: [
              { id: 'velho', name: 'CPF', type: 'short_text', type_config: {} },
              { id: 'novo', name: 'CPF', type: 'short_text', type_config: {} },
            ],
            pages: (async function* () {
              yield [{ id: 't1', name: 'x', status: { status: 'ok' }, custom_fields: [] }];
            })(),
          },
        ],
      });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const headers = wb.worksheets[0].getRow(1).values.slice(1);
      assert.deepEqual(headers, ['Nome da tarefa', 'CPF', 'CPF', 'Status']);
    } finally {
      listas.COLUNAS.length = 0;
      listas.COLUNAS.push(...original);
    }
  });

  await test('campo oculto que aparece tarde não aborta a exportação', async () => {
    const { writeWorkbook } = await import('../src/excel.js');
    const listas = await import('../src/listas.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
    const file = path.join(dir, 'oculto-tardio.xlsx');

    listas.CAMPOS_OCULTOS.push('Escondido');
    try {
      // O campo escondido não está nas definições nem na primeira página: antes,
      // a trava de campo tardio matava a exportação alegando que ele não teria
      // coluna — sendo que ele foi excluído de propósito.
      await writeWorkbook({
        filePath: file,
        sheets: [
          {
            list: { name: 'TESTE' },
            fieldDefinitions: [{ id: 'a', name: 'CPF', type: 'short_text', type_config: {} }],
            pages: (async function* () {
              yield [{ id: 't1', name: 'x', custom_fields: [{ id: 'a', type: 'short_text', value: '1' }] }];
              yield [
                {
                  id: 't2',
                  name: 'y',
                  custom_fields: [{ id: 'z', name: 'Escondido', type: 'short_text', value: 'segredo' }],
                },
              ];
            })(),
          },
        ],
      });

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      assert.equal(wb.worksheets[0].rowCount, 3, 'as duas tarefas deveriam estar na planilha');
    } finally {
      listas.CAMPOS_OCULTOS.length = 0;
      listas.CAMPOS_OCULTOS.push('Msg Proposta Pronta');
    }
  });

  await test('campo do tipo button não vira coluna', () => {
    const headers = sheet.getRow(1).values.slice(1);
    assert.ok(!headers.includes('Botão de ação'), 'campo button não deveria virar coluna');
  });

  await test('converte os valores dos campos customizados', () => {
    const headers = sheet.getRow(1).values.slice(1);
    const at = (name, row) => sheet.getRow(row).getCell(headers.indexOf(name) + 1).value;

    assert.equal(at('CPF', 2), '000.000.000-00');
    assert.equal(at('Valor do Precatório', 2), 1234.5); // número, dá para somar
    assert.equal(at('Fase', 2), 'Análise'); // id da opção virou o texto
    assert.equal(at('Fase', 3), 'Pago');
    assert.equal(at('Documentos OK', 2), 'Sim');
    assert.equal(at('Documentos OK', 3), 'Não');
    assert.equal(at('Etiquetas do processo', 2), 'Urgente, Revisar');
    assert.ok(at('Data da audiência', 2) instanceof Date, 'data deveria virar data de verdade');
    assert.equal(at('Campo herdado', 2), 'valor solto');
    assert.equal(at('Nome da tarefa', 2), 'Tarefa 0 — DIVANEIDE');
    assert.equal(at('ID da tarefa', 2), 't901-0');
    assert.equal(at('Status', 2), 'concluído');
    assert.equal(at('Responsável', 2), 'Hugo Silva');
    assert.equal(at('Etiquetas', 2), 'precatorio');
  });

  await test('cabeçalho congelado e autofiltro ativos', () => {
    assert.equal(sheet.views[0].state, 'frozen');
    assert.ok(sheet.autoFilter, 'autofiltro deveria estar ativo');
  });

  await test('pagina listas com mais de 100 tarefas', async () => {
    const res = await fetch(`${appUrl}/api/lists/902/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 200);

    const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
    const file = path.join(dir, 'grande.xlsx');
    await writeFile(file, Buffer.from(await res.arrayBuffer()));

    const big = new ExcelJS.Workbook();
    await big.xlsx.readFile(file);
    assert.equal(big.worksheets[0].rowCount, 251); // cabeçalho + 250 tarefas
  });

  await test('exporta a pasta inteira com uma aba por lista', async () => {
    // Instância própria: a pasta do teste tem duas listas defeituosas de
    // propósito (903 e 904), que existem para os testes de truncamento.
    const tmpIsolado = await mkdtemp(path.join(tmpdir(), 'clickup-tmpdir-'));
    const outraPorta = 3995;
    const outro = spawn(process.execPath, ['src/server.js'], {
      cwd: path.join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        CLICKUP_API_BASE: base,
        CLICKUP_TOKEN: 'pk_token_de_teste',
        CLICKUP_FOLDER_ID: '',
        CLICKUP_LIST_IDS: '901,902',
        AUTH_USER: USER,
        AUTH_PASSWORD: PASSWORD,
        PORT: String(outraPorta),
        TMPDIR: tmpIsolado,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    outro.stderr.on('data', (c) => process.stderr.write(`  [tudo] ${c}`));

    try {
      await waitForServer(`http://127.0.0.1:${outraPorta}/health`);
      const res = await fetch(`http://127.0.0.1:${outraPorta}/api/export-all.xlsx`, {
        headers: { Authorization: credentials },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /\.xlsx/);

      const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
      const file = path.join(dir, 'tudo.xlsx');
      await writeFile(file, Buffer.from(await res.arrayBuffer()));

      const tudo = new ExcelJS.Workbook();
      await tudo.xlsx.readFile(file);

      assert.deepEqual(
        tudo.worksheets.map((sheet) => sheet.name),
        ['DIVANEIDE', 'ANA CAROLINA'],
      );
      assert.equal(tudo.worksheets[0].rowCount, 4); // cabeçalho + 3
      assert.equal(tudo.worksheets[1].rowCount, 251); // cabeçalho + 250

      const headers = tudo.worksheets[1].getRow(1).values.slice(1);
      assert.equal(headers[0], 'Nome da tarefa');
      for (const esperado of ['CPF', 'Valor do Precatório', 'Fase', 'Etiquetas do processo']) {
        assert.ok(headers.includes(esperado), `faltou "${esperado}" na aba da pasta inteira`);
      }
    } finally {
      outro.kill();
    }
  });

  await test('exportação truncada falha em vez de entregar planilha incompleta', async () => {
    const res = await fetch(`${appUrl}/api/lists/903/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 502, 'deveria recusar, não devolver o arquivo');
    const body = await res.json();
    assert.match(body.error, /incompleta/i);
    assert.match(res.headers.get('content-type'), /json/, 'não pode sair como .xlsx');
  });

  await test('campo customizado que aparece tarde aborta em vez de sumir', async () => {
    const res = await fetch(`${appUrl}/api/lists/904/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /Campo que aparece tarde/);
  });

  await test('download interrompido não vaza file descriptor', async () => {
    const { readdir, readlink } = await import('node:fs/promises');
    const fds = async () => {
      const lista = await readdir(`/proc/${child.pid}/fd`);
      const alvos = await Promise.all(
        lista.map((fd) => readlink(`/proc/${child.pid}/fd/${fd}`).catch(() => '')),
      );
      return alvos.filter((alvo) => alvo.endsWith('.xlsx')).length;
    };

    const antes = await fds();

    // 30 downloads que o cliente abandona logo depois do primeiro pedaço.
    for (let i = 0; i < 30; i++) {
      const controller = new AbortController();
      try {
        const res = await fetch(`${appUrl}/api/lists/902/export.xlsx`, {
          headers: { Authorization: credentials },
          signal: controller.signal,
        });
        const reader = res.body.getReader();
        await reader.read();
        controller.abort();
      } catch {
        /* o abort é o objetivo */
      }
    }

    await sleep(500);
    const depois = await fds();
    assert.ok(
      depois - antes <= 2,
      `30 downloads abortados deixaram ${depois - antes} descritores abertos no .xlsx`,
    );
  });

  await test('modo assíncrono responde na hora e o arquivo sai depois', async () => {
    const token = 'token-async';
    const inicio = Date.now();

    // Passo 1: dispara e volta imediatamente, sem segurar a conexão.
    const disparo = await fetch(`${appUrl}/api/lists/902/export.xlsx?p=${token}&async=1`, {
      headers: { Authorization: credentials },
    });
    assert.equal(disparo.status, 202);
    assert.equal((await disparo.json()).status, 'gerando');
    assert.ok(Date.now() - inicio < 2000, 'o 202 tem que ser imediato');

    // Passo 2: acompanha até terminar.
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i++) {
      await sleep(200);
      const res = await fetch(`${appUrl}/api/progress/${token}`, {
        headers: { Authorization: credentials },
      });
      const progresso = await res.json();
      assert.ok(!progresso.error, `erro na geração: ${progresso.error}`);
      pronto = progresso.done;
    }
    assert.ok(pronto, 'a geração não terminou');

    // Passo 3: o arquivo vem do cache.
    const arquivo = await fetch(`${appUrl}/api/lists/902/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(arquivo.status, 200);
    const buf = Buffer.from(await arquivo.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK', 'deveria ser um .xlsx válido');
  });

  await test('modo assíncrono reporta a falha em vez de ficar preso', async () => {
    const token = 'token-async-erro';
    const disparo = await fetch(`${appUrl}/api/lists/903/export.xlsx?p=${token}&async=1`, {
      headers: { Authorization: credentials },
    });
    assert.equal(disparo.status, 202);

    let erro = null;
    for (let i = 0; i < 60 && !erro; i++) {
      await sleep(200);
      const res = await fetch(`${appUrl}/api/progress/${token}`, {
        headers: { Authorization: credentials },
      });
      const progresso = await res.json();
      if (progresso.error) erro = progresso.error;
    }
    assert.match(erro || '', /incompleta/i, 'o erro tem que chegar pelo progresso');
  });

  await test('segundo cliente na mesma exportação também recebe progresso', async () => {
    const tokenA = 'dois-clientes-A';
    const tokenB = 'dois-clientes-B';

    // A dispara; B entra no meio da MESMA geração (mesma lista, cache limpo).
    const a = fetch(`${appUrl}/api/lists/904/export.xlsx?p=${tokenA}&async=1`, {
      headers: { Authorization: credentials },
    });
    await sleep(80);
    const b = fetch(`${appUrl}/api/lists/904/export.xlsx?p=${tokenB}&async=1`, {
      headers: { Authorization: credentials },
    });
    await Promise.all([a, b]);

    // Os dois têm que sair do "gerando", com sucesso ou com erro — nunca ficar
    // presos. O que travava a tela era B nunca receber nada.
    const estado = async (t) => {
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${appUrl}/api/progress/${t}`, {
          headers: { Authorization: credentials },
        });
        const p = await res.json();
        if (p.done || p.error) return p;
        await sleep(200);
      }
      return null;
    };

    const [pa, pb] = await Promise.all([estado(tokenA), estado(tokenB)]);
    assert.ok(pa, 'o primeiro cliente ficou preso');
    assert.ok(pb, 'o segundo cliente ficou preso — ele não recebia progresso nenhum');
  });

  await test('o filtro de concluídas muda a planilha e não colide no cache', async () => {
    const baixar = async (concluidas) => {
      const res = await fetch(`${appUrl}/api/lists/901/export.xlsx?concluidas=${concluidas}`, {
        headers: { Authorization: credentials },
      });
      assert.equal(res.status, 200);
      const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
      const file = path.join(dir, `f-${concluidas}.xlsx`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      return { linhas: wb.worksheets[0].rowCount - 1, nome: res.headers.get('content-disposition') };
    };

    const com = await baixar(1);
    const sem = await baixar(0);

    // A lista 901 tem 3 tarefas, 2 delas concluídas: a 0 com status do tipo
    // "closed" (que o ClickUp filtra) e a 2 do tipo "done" (que ele devolve
    // mesmo com include_closed=false, e o app precisa descartar).
    assert.equal(com.linhas, 3);
    assert.equal(sem.linhas, 1, 'sem concluídas deveria sobrar só a tarefa em aberto');
    assert.match(sem.nome, /EM-ABERTO/, 'o nome do arquivo deveria distinguir os dois');

    // E de novo, agora que os dois estão em cache: cada um tem que voltar o seu.
    assert.equal((await baixar(1)).linhas, 3, 'o cache devolveu o arquivo do outro filtro');
    assert.equal((await baixar(0)).linhas, 1, 'o cache devolveu o arquivo do outro filtro');
  });

  await test('o progresso é reportado durante a exportação', async () => {
    const token = 'token-de-teste';
    const download = fetch(`${appUrl}/api/lists/902/export.xlsx?p=${token}&nocache=1`, {
      headers: { Authorization: credentials },
    });
    await sleep(60);
    const res = await fetch(`${appUrl}/api/progress/${token}`, { headers: { Authorization: credentials } });
    const progress = await res.json();
    assert.ok('fetched' in progress, 'o endpoint de progresso deveria responder');
    await download;
  });

  console.log('\nSomente leitura');

  await test('o app só fez GET no ClickUp durante todos os testes', () => {
    const escritas = requests.filter((request) => request.method !== 'GET');
    assert.equal(
      escritas.length,
      0,
      `houve ${escritas.length} requisição(ões) de escrita: ${escritas
        .map((r) => `${r.method} ${r.path}`)
        .join(', ')}`,
    );
    assert.ok(requests.length > 5, 'esperava várias leituras registradas');
  });

  await test('a trava recusa POST, PUT e DELETE', async () => {
    const { safeFetch } = await import('../src/clickup.js');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.throws(
        () => safeFetch(`${base}/list/901/task`, { method }),
        /somente leitura/i,
        `${method} deveria ser bloqueado`,
      );
    }
  });

  await test('a trava recusa corpo na requisição', async () => {
    const { safeFetch } = await import('../src/clickup.js');
    assert.throws(() => safeFetch(`${base}/list/901/task`, { body: '{}' }), /corpo/i);
  });

  await test('a trava recusa destino fora da API do ClickUp', async () => {
    const { safeFetch } = await import('../src/clickup.js');
    assert.throws(() => safeFetch('https://exemplo.invalido/roubo', {}), /fora da API/i);
  });

  // Achados da auditoria: a validação antiga era startsWith sobre a string crua,
  // então normalização de caminho e host colado passavam.
  // Precisa ser testado contra a base de produção (que tem caminho /api/v2): no
  // ClickUp falso a base é só o host, e aí a origem inteira é a API mesmo.
  await test('a trava recusa travessia de caminho para fora do prefixo', async () => {
    const { dentroDaApi } = await import('../src/clickup.js');
    const producao = new URL('https://api.clickup.com/api/v2');

    assert.equal(dentroDaApi('https://api.clickup.com/api/v2/list/901/task', producao), true);
    assert.equal(dentroDaApi('https://api.clickup.com/api/v2/../../roubo', producao), false);
    assert.equal(dentroDaApi('https://api.clickup.com/api/v2/list/../../../roubo', producao), false);
    assert.equal(dentroDaApi('https://api.clickup.com/api/v1/task/901', producao), false);
    assert.equal(dentroDaApi('https://api.clickup.com/api/v2.atacante.com/x', producao), false);
    assert.equal(dentroDaApi('https://outro.host/api/v2/list/901', producao), false);
  });

  await test('a trava recusa host colado no prefixo', async () => {
    const { safeFetch } = await import('../src/clickup.js');
    assert.throws(() => safeFetch(`${base}.dominio-do-atacante.com/x`, {}), /fora da API/i);
    assert.throws(() => safeFetch('https://api.clickup.com.atacante.com/api/v2/x', {}), /fora da API/i);
  });

  await test('a trava recusa credenciais embutidas na URL', async () => {
    const { safeFetch } = await import('../src/clickup.js');
    assert.throws(() => safeFetch('https://usuario:senha@api.clickup.com/api/v2/x', {}), /fora da API/i);
  });

  await test('CLICKUP_API_BASE só aceita loopback', async () => {
    const { resolveApiBase } = await import('../src/clickup.js');
    const oficial = 'https://api.clickup.com/api/v2';
    assert.equal(resolveApiBase('http://api.do-atacante.com'), oficial, 'host externo deveria ser ignorado');
    assert.equal(resolveApiBase('nao-e-url'), oficial, 'lixo deveria ser ignorado');
    assert.equal(resolveApiBase(''), oficial, 'sem override, usa a API oficial');
    assert.equal(resolveApiBase('https://api.clickup.com.atacante.com'), oficial, 'host colado é ignorado');
    assert.equal(resolveApiBase('http://127.0.0.1:9999'), 'http://127.0.0.1:9999', 'loopback é permitido');
  });

  await test('id com travessia é recusado antes de virar requisição', async () => {
    const { getFolder, getListFields } = await import('../src/clickup.js');
    await assert.rejects(() => getFolder('../v2/task/roubo'), /inválido/i);
    await assert.rejects(() => getListFields('901/../../roubo'), /inválido/i);
  });

  await test('Atualizar invalida também as planilhas guardadas', async () => {
    const chamadas = () => requests.filter((r) => r.path.includes('/list/901/task')).length;
    const baixar = async () => {
      const res = await fetch(`${appUrl}/api/lists/901/export.xlsx`, {
        headers: { Authorization: credentials },
      });
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    };
    const atualizar = () =>
      fetch(`${appUrl}/api/lists?refresh=1`, { headers: { Authorization: credentials } });

    // Parte do zero: testes anteriores já deixaram esta lista em cache.
    await atualizar();
    const zero = chamadas();
    await baixar();
    const depoisDaPrimeira = chamadas();
    assert.ok(depoisDaPrimeira > zero, 'depois de Atualizar, a planilha tinha que ser refeita');

    // Sem Atualizar: vem do cache, sem tocar na API.
    await baixar();
    assert.equal(chamadas(), depoisDaPrimeira, 'a segunda deveria vir do cache');

    // Com Atualizar de novo: descarta o cache e refaz.
    await atualizar();
    await baixar();
    assert.ok(chamadas() > depoisDaPrimeira, 'Atualizar deveria ter descartado o cache');
  });

  await test('segundo download da mesma lista vem do cache', async () => {
    const started = Date.now();
    const res = await fetch(`${appUrl}/api/lists/901/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.ok(Date.now() - started < 1000, 'download em cache deveria ser imediato');
  });

  await test('a contagem real muda com o filtro, ao contrário do task_count', async () => {
    const contar = async (concluidas) => {
      const res = await fetch(`${appUrl}/api/lists/901/contagem?concluidas=${concluidas}`, {
        headers: { Authorization: credentials },
      });
      assert.equal(res.status, 200);
      return (await res.json()).total;
    };

    // A lista 901 tem 3 tarefas: uma em aberto, uma com status do tipo "closed"
    // e uma do tipo "done". Só a primeira sobra quando as concluídas saem.
    assert.equal(await contar(1), 3);
    assert.equal(await contar(0), 1);

    // O task_count do catálogo continua 3 nos dois casos — é justamente essa
    // diferença que o número clicável da tela existe para mostrar.
    const lists = await (
      await fetch(`${appUrl}/api/lists`, { headers: { Authorization: credentials } })
    ).json();
    const divaneide = lists.lists.find((list) => list.id === '901');
    assert.equal(divaneide.taskCount, 3);
    assert.equal(divaneide.contado.com, 3);
    assert.equal(divaneide.contado.sem, 1);
  });

  await test('a contagem não pode virar porta para listas fora do escopo', async () => {
    const res = await fetch(`${appUrl}/api/lists/999/contagem`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 404);
  });

  await test('a segunda contagem vem do cache, sem tocar na API', async () => {
    const chamadas = () => requests.filter((r) => r.path.includes('/list/902/task')).length;
    await fetch(`${appUrl}/api/lists/902/contagem?concluidas=1`, {
      headers: { Authorization: credentials },
    });
    const depois = chamadas();
    assert.ok(depois > 0, 'a primeira contagem tinha que paginar as tarefas');

    await fetch(`${appUrl}/api/lists/902/contagem?concluidas=1`, {
      headers: { Authorization: credentials },
    });
    assert.equal(chamadas(), depois, 'a segunda deveria vir do cache');
  });

  // Por último: este bloco bloqueia o IP de teste de propósito.
  console.log('\nForça bruta');

  const errada = `Basic ${Buffer.from(`${USER}:chute`).toString('base64')}`;

  await test('depois de muitas senhas erradas o IP é bloqueado com 429', async () => {
    let bloqueio = null;
    for (let i = 0; i < 12 && !bloqueio; i++) {
      const res = await fetch(`${appUrl}/api/lists`, { headers: { Authorization: errada } });
      if (res.status === 429) bloqueio = res;
      else assert.equal(res.status, 401, `tentativa ${i + 1} deveria ser 401 antes do bloqueio`);
    }
    assert.ok(bloqueio, 'esperava um 429 depois das tentativas');
    assert.ok(Number(bloqueio.headers.get('retry-after')) > 0, 'faltou o cabeçalho Retry-After');
  });

  await test('durante o bloqueio nem a senha certa passa', async () => {
    const res = await fetch(`${appUrl}/api/lists`, { headers: { Authorization: credentials } });
    assert.equal(res.status, 429);
  });

  await test('o bloqueio expira sozinho e a senha certa volta a funcionar', async () => {
    await sleep(2400); // AUTH_BLOCK_SECONDS=2
    const res = await fetch(`${appUrl}/api/lists`, { headers: { Authorization: credentials } });
    assert.equal(res.status, 200);
  });
} finally {
  child.kill();
  fake.close();
}

console.log(failures ? `\n${failures} teste(s) falharam\n` : '\nTodos os testes passaram\n');
process.exit(failures ? 1 : 0);
