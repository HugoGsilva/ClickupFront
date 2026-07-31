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
      ['DIVANEIDE', 'ANA CAROLINA'],
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

  await test('traz só o nome da tarefa como coluna padrão', () => {
    const headers = sheet.getRow(1).values.slice(1);
    assert.equal(headers[0], 'Nome da tarefa');

    // Colunas do ClickUp que ficaram de fora de propósito: a planilha é sobre
    // os campos customizados.
    for (const fora of ['ID', 'Status', 'Prioridade', 'Responsáveis', 'Prazo', 'Descrição', 'Link']) {
      assert.ok(!headers.includes(fora), `"${fora}" não deveria estar na planilha`);
    }
  });

  await test('traz uma coluna por campo customizado, inclusive os herdados', () => {
    const headers = sheet.getRow(1).values.slice(1);
    for (const expected of [
      'CPF',
      'Valor do Precatório',
      'Fase',
      'Data da audiência',
      'Documentos OK',
      'Etiquetas',
      'Campo herdado',
    ]) {
      assert.ok(headers.includes(expected), `faltou o campo customizado "${expected}"`);
    }
  });

  await test('respeita a ordem de colunas definida em listas.js', async () => {
    const { ORDEM_DOS_CAMPOS } = await import('../src/listas.js');
    const headers = sheet.getRow(1).values.slice(1);

    // Só os campos que estão na ordem configurada, na sequência em que aparecem.
    const configurados = headers.filter((h) => ORDEM_DOS_CAMPOS.includes(h));
    const esperados = ORDEM_DOS_CAMPOS.filter((nome) => headers.includes(nome));
    assert.deepEqual(configurados, esperados);
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
    assert.equal(at('Etiquetas', 2), 'Urgente, Revisar');
    assert.ok(at('Data da audiência', 2) instanceof Date, 'data deveria virar data de verdade');
    assert.equal(at('Campo herdado', 2), 'valor solto');
    assert.equal(at('Nome da tarefa', 2), 'Tarefa 0 — DIVANEIDE');
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
    const res = await fetch(`${appUrl}/api/export-all.xlsx`, {
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

    // Os campos customizados também vêm nas abas do arquivo completo.
    const headers = tudo.worksheets[1].getRow(1).values.slice(1);
    assert.equal(headers[0], 'Nome da tarefa');
    for (const esperado of ['CPF', 'Valor do Precatório', 'Fase', 'Etiquetas']) {
      assert.ok(headers.includes(esperado), `faltou "${esperado}" na aba da pasta inteira`);
    }
  });

  await test('listas com o mesmo nome não quebram o arquivo', async () => {
    const { writeWorkbook } = await import('../src/excel.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'clickup-test-'));
    const file = path.join(dir, 'repetidas.xlsx');

    const tarefa = { id: 't1', name: 'x', custom_fields: [] };
    const pagina = async function* () {
      yield [tarefa];
    };

    await writeWorkbook({
      filePath: file,
      sheets: [
        { list: { name: 'ANA' }, pages: pagina() },
        { list: { name: 'ANA' }, pages: pagina() },
        { list: { name: 'ANA' }, pages: pagina() },
      ],
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    assert.deepEqual(
      wb.worksheets.map((sheet) => sheet.name),
      ['ANA', 'ANA (2)', 'ANA (3)'],
    );
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

  await test('segundo download da mesma lista vem do cache', async () => {
    const started = Date.now();
    const res = await fetch(`${appUrl}/api/lists/901/export.xlsx`, {
      headers: { Authorization: credentials },
    });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    assert.ok(Date.now() - started < 1000, 'download em cache deveria ser imediato');
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
