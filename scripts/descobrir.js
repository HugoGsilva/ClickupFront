/**
 * Descobre os ids do ClickUp — roda na SUA máquina, com o SEU token.
 *
 *   npm run descobrir
 *
 * Precisa só de CLICKUP_TOKEN e CLICKUP_TEAM_ID no .env. O team id é o primeiro
 * número da URL do ClickUp:
 *
 *   https://app.clickup.com/9013302815/v/l/8ckr5gz-2173
 *                          ^^^^^^^^^^ este
 *
 * Imprime a árvore de espaços, pastas e listas com os ids que o app usa. Existe
 * porque o id que aparece na URL de uma lista (o "8ckr5gz-2173" acima) é o id
 * da VIEW, não da lista — a API não aceita aquele valor.
 *
 * Só faz leitura, pela mesma trava do resto do app, e não envia nada a lugar
 * nenhum: apenas imprime.
 */
import { config } from '../src/config.js';
import { getSpaces, getFolders, getFolderlessLists } from '../src/clickup.js';

const pad = (text, width) => String(text).padEnd(width);
const num = (value) => (value === null || value === undefined ? '?' : new Intl.NumberFormat('pt-BR').format(value));

if (!config.clickupToken) {
  console.error('\nCLICKUP_TOKEN não definido no .env.\n');
  process.exit(1);
}
if (!config.teamId) {
  console.error('\nCLICKUP_TEAM_ID não definido no .env.');
  console.error('É o primeiro número da URL do ClickUp: app.clickup.com/<ESTE>/v/l/...\n');
  process.exit(1);
}

console.log(`\nTime ${config.teamId}`);

let espacos;
try {
  espacos = await getSpaces(config.teamId);
} catch (err) {
  console.error(`\nFalhou: ${err.message}`);
  console.error('Confira CLICKUP_TOKEN e CLICKUP_TEAM_ID.\n');
  process.exit(1);
}

if (!espacos.length) {
  console.log('  (nenhum espaço visível para este token)');
}

for (const espaco of espacos) {
  console.log(`\n  ESPAÇO  ${pad(espaco.id, 14)}${espaco.name}`);

  const pastas = await getFolders(espaco.id).catch((err) => {
    console.log(`    (erro ao ler pastas: ${err.message})`);
    return [];
  });

  for (const pasta of pastas) {
    console.log(`\n    PASTA   ${pad(pasta.id, 14)}${pasta.name}`);
    console.log(`            ${pad('', 14)}└─ CLICKUP_FOLDER_ID=${pasta.id}`);

    for (const lista of pasta.lists || []) {
      console.log(`      lista ${pad(lista.id, 14)}${pad(lista.name, 32)}${num(lista.task_count)} tarefas`);
    }
  }

  const soltas = await getFolderlessLists(espaco.id).catch(() => []);
  if (soltas.length) {
    console.log('\n    (listas fora de pasta)');
    for (const lista of soltas) {
      console.log(`      lista ${pad(lista.id, 14)}${pad(lista.name, 32)}${num(lista.taskCount)} tarefas`);
    }
  }
}

console.log(`
${'─'.repeat(72)}
Como usar:
  - pasta inteira      -> CLICKUP_FOLDER_ID=<id da PASTA>
  - listas específicas -> CLICKUP_LIST_IDS=<id da lista>,<outro id>

Este relatório mostra nomes de espaços, pastas e listas — nenhum dado de tarefa.
`);
