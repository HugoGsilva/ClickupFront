/**
 * Diagnóstico do ClickUp — roda na SUA máquina, com o SEU token, e imprime um
 * relatório do formato dos campos (nomes e tipos), com os VALORES MASCARADOS.
 *
 *   npm run diagnostico
 *   npm run diagnostico -- --lista 901234      # só uma lista
 *   npm run diagnostico -- --amostra 20        # quantas tarefas analisar
 *   npm run diagnostico -- --sem-mascara       # mostra os valores (NÃO compartilhe)
 *
 * O relatório é feito para poder ser compartilhado: ele diz "texto (14 caracteres)"
 * em vez do CPF, "número" em vez do valor. O que aparece por extenso é só o nome
 * do campo, o tipo e os rótulos das opções de dropdown — que é o necessário para
 * conferir se a exportação está convertendo tudo certo.
 *
 * Nada é enviado para lugar nenhum: o script só imprime na tela.
 */
import { config, configProblems } from '../src/config.js';
import { getFolder, getListFields, fetchAllTasks } from '../src/clickup.js';
import { formatCustomFieldValue } from '../src/excel.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const has = (name) => args.includes(name);

const onlyList = flag('--lista');
const sampleSize = Number(flag('--amostra') || 10);
const mask = !has('--sem-mascara');

const pad = (text, width) => String(text).padEnd(width);

/** Descreve o valor sem revelá-lo. */
function describe(value) {
  if (value === null || value === undefined || value === '') return 'vazio';
  if (value instanceof Date) return `data ✓ (${value.getUTCFullYear()})`;
  if (typeof value === 'number') return `número ✓`;
  if (typeof value === 'string') {
    if (value === 'Sim' || value === 'Não') return `"${value}" ✓`;
    return `texto ✓ (${value.length} caracteres)`;
  }
  return `${typeof value} ✓`;
}

/** Valores que ainda parecem id cru são o sintoma de conversão que falhou. */
function looksUnconverted(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(value);
}

async function analisarLista(list) {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Lista "${list.name}" — ${list.taskCount ?? '?'} tarefas no total`);
  console.log('─'.repeat(72));

  const definitions = await getListFields(list.id).catch((err) => {
    console.log(`  aviso: não consegui ler as definições de campo (${err.message})`);
    return [];
  });

  const page = await fetchAllTasks(list.id, { maxPages: 1 });
  const sample = page.slice(0, sampleSize);

  if (!sample.length) {
    console.log('  (lista sem tarefas na primeira página — nada para analisar)');
    return { alertas: [] };
  }

  console.log(`  amostra analisada: ${sample.length} tarefa(s)\n`);

  // Campos definidos na lista + campos que só aparecem nas tarefas.
  const byId = new Map();
  for (const definition of definitions) byId.set(definition.id, { definition, extra: false });
  for (const task of sample) {
    for (const field of task.custom_fields || []) {
      if (!byId.has(field.id)) byId.set(field.id, { definition: field, extra: true });
    }
  }

  if (!byId.size) {
    console.log('  nenhum campo customizado nesta lista');
    return { alertas: [] };
  }

  console.log(
    `  ${pad('Campo', 30)}${pad('Tipo no ClickUp', 22)}${pad('Preenchidos', 13)}Como sai no Excel`,
  );
  console.log(`  ${'-'.repeat(30)}${'-'.repeat(22)}${'-'.repeat(13)}${'-'.repeat(30)}`);

  const alertas = [];

  for (const [id, { definition, extra }] of byId) {
    let preenchidos = 0;
    let exemplo = null;
    let cru = false;

    for (const task of sample) {
      const field = (task.custom_fields || []).find((candidate) => candidate.id === id);
      if (!field) continue;
      const value = formatCustomFieldValue({
        ...field,
        type: field.type || definition.type,
        type_config: definition.type_config || field.type_config,
      });
      if (value === null || value === undefined || value === '') continue;
      preenchidos++;
      if (exemplo === null) exemplo = value;
      if (looksUnconverted(value)) cru = true;
    }

    const nome = (definition.name || id).slice(0, 29);
    const tipo = definition.type + (extra ? ' *' : '');

    let saida;
    if (!mask) {
      saida = JSON.stringify(exemplo);
    } else if (definition.type === 'drop_down' || definition.type === 'labels') {
      // Aqui o que importa é saber se o id da opção virou o texto dela.
      const opcoes = definition.type_config?.options?.length ?? 0;
      saida = exemplo === null ? 'vazio' : `${opcoes} opções, resolvido ${cru ? '✗' : '✓'}`;
    } else {
      saida = describe(exemplo);
    }

    console.log(`  ${pad(nome, 30)}${pad(tipo, 22)}${pad(`${preenchidos}/${sample.length}`, 13)}${saida}`);

    if (cru) {
      alertas.push(`campo "${definition.name}" (${definition.type}) saiu como id cru — a conversão falhou`);
    }
    if (definition.type === 'drop_down' || definition.type === 'labels') {
      const opcoes = definition.type_config?.options || [];
      if (!opcoes.length) {
        alertas.push(`campo "${definition.name}" (${definition.type}) veio sem a lista de opções`);
      }
    }
  }

  const extras = [...byId.values()].filter((entry) => entry.extra).length;
  if (extras) {
    console.log(`\n  * ${extras} campo(s) apareceram nas tarefas mas não na definição da lista.`);
    console.log('    Eles também viram coluna, no fim do bloco de campos customizados.');
  }

  // Campos padrão preenchidos, para saber quais colunas fazem sentido manter.
  const padroes = [
    ['Prioridade', (task) => task.priority],
    ['Responsáveis', (task) => task.assignees?.length],
    ['Tags', (task) => task.tags?.length],
    ['Prazo', (task) => task.due_date],
    ['Início', (task) => task.start_date],
    ['Tempo estimado', (task) => task.time_estimate],
    ['Tempo gasto', (task) => task.time_spent],
    ['Descrição', (task) => task.text_content || task.description],
    ['ID customizado', (task) => task.custom_id],
    ['Subtarefa (tem pai)', (task) => task.parent],
  ];

  console.log('\n  Campos padrão preenchidos na amostra:');
  for (const [nome, get] of padroes) {
    const total = sample.filter((task) => {
      const value = get(task);
      return value !== null && value !== undefined && value !== '' && value !== 0;
    }).length;
    console.log(`    ${pad(nome, 24)} ${total}/${sample.length}`);
  }

  return { alertas };
}

// ---------------------------------------------------------------------------

const problems = configProblems().filter((problem) => !problem.startsWith('AUTH_'));
if (problems.length) {
  console.error('\nFalta configurar:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nPreencha o .env e rode de novo.\n');
  process.exit(1);
}

console.log('\nConectando no ClickUp…');

let folder;
try {
  folder = await getFolder(config.folderId);
} catch (err) {
  console.error(`\nFalhou: ${err.message}`);
  console.error('Confira CLICKUP_TOKEN e CLICKUP_FOLDER_ID no .env.\n');
  process.exit(1);
}

console.log(`  ok — pasta "${folder.name}" com ${folder.lists.length} lista(s)\n`);
for (const list of folder.lists) {
  console.log(`  ${pad(list.id, 14)}${pad(list.name, 30)}${list.taskCount ?? '?'} tarefas`);
}

const alvos = onlyList
  ? folder.lists.filter((list) => list.id === onlyList)
  : folder.lists.slice(0, 1);

if (!alvos.length) {
  console.error(`\nLista ${onlyList} não está nesta pasta. Listas disponíveis:`);
  for (const list of folder.lists) console.error(`  ${list.id}  ${list.name}`);
  process.exit(1);
}

if (!onlyList && folder.lists.length > 1) {
  console.log(`  (analisando só a primeira lista; use --lista <id> para escolher outra)`);
}

const alertas = [];
for (const list of alvos) {
  const result = await analisarLista(list);
  alertas.push(...result.alertas);
}

console.log(`\n${'═'.repeat(72)}`);
if (alertas.length) {
  console.log('Pontos de atenção:');
  for (const alerta of alertas) console.log(`  ! ${alerta}`);
} else {
  console.log('Nenhum problema de conversão encontrado na amostra.');
}
console.log(
  mask
    ? '\nEste relatório está com os valores mascarados — pode ser compartilhado.\n'
    : '\nATENÇÃO: rodado com --sem-mascara, contém dados reais. NÃO compartilhe.\n',
);
