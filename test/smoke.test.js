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
// Também vale para este processo, que importa src/clickup.js direto nos testes da trava.
process.env.CLICKUP_API_BASE = base;
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

  await test('traz as colunas padrão', () => {
    const headers = sheet.getRow(1).values.slice(1);
    for (const expected of ['ID', 'Nome', 'Status', 'Prioridade', 'Responsáveis', 'Prazo', 'Link']) {
      assert.ok(headers.includes(expected), `faltou a coluna "${expected}" em ${headers.join(', ')}`);
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
  });

  await test('converte os campos padrão', () => {
    const headers = sheet.getRow(1).values.slice(1);
    const at = (name, row) => sheet.getRow(row).getCell(headers.indexOf(name) + 1).value;

    assert.equal(at('Status', 2), 'concluído');
    assert.equal(at('Prioridade', 2), 'Urgente');
    assert.equal(at('Responsáveis', 2), 'Hugo Silva');
    assert.equal(at('ID customizado', 2), 'PREC-1');
    assert.equal(at('Tempo estimado (h)', 2), 1);
    assert.ok(at('Criada em', 2) instanceof Date);
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
