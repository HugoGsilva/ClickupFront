import ExcelJS from 'exceljs';
import { COLUNAS, CAMPOS_OCULTOS } from './listas.js';

const MAX_CELL_LENGTH = 32_000; // limite do Excel é 32.767 caracteres por célula

const CURRENCY_SYMBOLS = {
  BRL: 'R$',
  USD: 'US$',
  EUR: '€',
  GBP: '£',
};

const FORMATS = {
  datetime: 'dd/mm/yyyy hh:mm',
  date: 'dd/mm/yyyy',
  number: '#,##0.##',
  percent: '0"%"',
};

/**
 * ExcelJS grava datas como se fossem UTC. Deslocamos pelo fuso do servidor para
 * que a planilha mostre o mesmo horário que o ClickUp mostra na tela.
 */
function toExcelDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
}

function truncate(text) {
  if (typeof text !== 'string') return text;
  return text.length > MAX_CELL_LENGTH ? `${text.slice(0, MAX_CELL_LENGTH - 1)}…` : text;
}

function names(items, ...keys) {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item !== 'object') return String(item);
      for (const key of keys) {
        if (item[key]) return String(item[key]);
      }
      return item.id ? String(item.id) : '';
    })
    .filter(Boolean)
    .join(', ');
}

/** Encontra a opção de um campo drop_down pelo id ou pelo índice de ordenação. */
function findOption(typeConfig, value) {
  const options = typeConfig?.options || [];
  return (
    options.find((option) => option.id === value) ??
    options.find((option) => String(option.orderindex) === String(value))
  );
}

function optionLabel(option) {
  if (!option) return null;
  return option.name ?? option.label ?? null;
}

/**
 * Converte o valor cru de um campo customizado no que deve aparecer na planilha.
 * Cada tipo do ClickUp guarda o valor de um jeito diferente: drop_down guarda o
 * id da opção, date guarda milissegundos, labels guarda um array de ids, etc.
 */
export function formatCustomFieldValue(field) {
  const { type, value, type_config: typeConfig = {} } = field || {};
  if (value === null || value === undefined || value === '') return null;

  switch (type) {
    case 'drop_down':
      return optionLabel(findOption(typeConfig, value)) ?? String(value);

    case 'labels': {
      const ids = Array.isArray(value) ? value : [value];
      return (
        ids
          .map((id) => optionLabel(findOption(typeConfig, id)) ?? String(id))
          .filter(Boolean)
          .join(', ') || null
      );
    }

    case 'checkbox':
      return value === true || value === 'true' ? 'Sim' : 'Não';

    case 'date':
      return toExcelDate(value);

    case 'currency':
    case 'number': {
      // Number('  ') é 0: um campo de valor com só espaços virava R$ 0,00 numa
      // coluna de precatório, sem erro nenhum. E '1.234,56' virava NaN e caía
      // como texto numa célula formatada como moeda, que o SOMA ignora em
      // silêncio. Aqui só vira número o que é inequivocamente número; o resto
      // fica visível como texto, para alguém perceber em vez de somar errado.
      const cru = typeof value === 'number' ? String(value) : String(value).trim();
      if (!cru) return null;
      return /^-?\d+(\.\d+)?$/.test(cru) ? Number(cru) : cru;
    }

    case 'emoji': {
      const num = Number(value);
      return Number.isFinite(num) ? num : String(value);
    }

    case 'users':
      return names(Array.isArray(value) ? value : [value], 'username', 'email', 'name') || null;

    case 'tasks':
    case 'list_relationship':
      return names(Array.isArray(value) ? value : [value], 'name') || null;

    case 'attachment':
    case 'files':
      return names(Array.isArray(value) ? value : [value], 'url', 'title', 'name') || null;

    case 'location':
      // Alguns campos de local vêm como texto simples em vez de objeto.
      if (typeof value === 'string') return value;
      return value.formatted_address || value.place_name || null;

    // Botão de ação da interface do ClickUp: não carrega dado. A coluna existe
    // para o export refletir todos os campos da lista, mas fica vazia em vez de
    // despejar JSON.
    case 'button':
      return null;

    case 'manual_progress':
    case 'automatic_progress': {
      // Pode vir como objeto {percent_complete} ou como número puro.
      const bruto = typeof value === 'object' ? (value.percent_complete ?? value.current) : value;
      const percent = Number(bruto);
      return Number.isFinite(percent) ? percent : null;
    }

    case 'formula':
    case 'rollup':
      if (typeof value === 'object') return truncate(JSON.stringify(value));
      return typeof value === 'number' ? value : String(value);

    default:
      if (typeof value === 'object') return truncate(JSON.stringify(value));
      return truncate(String(value));
  }
}

/** Formato de célula adequado ao tipo do campo customizado. */
function customFieldFormat(field) {
  switch (field.type) {
    case 'date':
      return field.type_config?.include_time === false ? FORMATS.date : FORMATS.datetime;
    case 'currency': {
      const symbol = CURRENCY_SYMBOLS[field.type_config?.currency_type] || '';
      return symbol ? `"${symbol}" #,##0.00` : '#,##0.00';
    }
    case 'number':
    case 'emoji':
      return FORMATS.number;
    case 'manual_progress':
    case 'automatic_progress':
      return FORMATS.percent;
    default:
      return null;
  }
}

/**
 * Une as definições de campo da lista com os campos que realmente apareceram nas
 * tarefas. A definição da lista manda na ordem; campos vindos só das tarefas
 * (herdados de outro nível, por exemplo) entram no fim.
 */
function collectCustomFields(fieldDefinitions, tasks) {
  const fields = new Map();
  const vistos = new Set();

  for (const definition of fieldDefinitions || []) {
    if (definition?.id) {
      fields.set(definition.id, definition);
      vistos.add(definition.id);
    }
  }
  for (const task of tasks) {
    for (const field of task.custom_fields || []) {
      if (!field?.id) continue;
      vistos.add(field.id);
      if (!fields.has(field.id)) fields.set(field.id, field);
    }
  }

  const encontrados = [...fields.values()].filter(
    (definition) =>
      // Botão é ação da interface, não dado.
      definition.type !== 'button' &&
      // E o que estiver na lista de ocultos de src/listas.js.
      !CAMPOS_OCULTOS.includes(definition.name),
  );

  // `vistos` inclui o que foi deixado de fora de propósito (button e
  // CAMPOS_OCULTOS). Sem essa separação, esconder um campo o tornava
  // "desconhecido" e a trava de campo tardio abortava toda exportação em que
  // ele tivesse valor — ou seja, a funcionalidade nascia quebrada.
  return { colunas: encontrados, vistos };
}

/**
 * Como cada coluna padrão é lida da tarefa. A chave vem de COLUNAS, em
 * src/listas.js, que decide quais entram, em que ordem e com que título.
 *
 * Sobre as duas datas de fim: o ClickUp tem `date_done` (concluída) e
 * `date_closed` (fechada), e elas não coincidem — nas tarefas reais desta pasta
 * a primeira vem preenchida em 93% e a segunda em 4%. Exportar só uma
 * deixaria a coluna praticamente vazia.
 */
const LEITORES_PADRAO = {
  nome: { width: 45, get: (task) => truncate(task.name || '') },
  id: { width: 14, get: (task) => task.id || '' },
  status: { width: 18, get: (task) => task.status?.status || '' },
  responsavel: { width: 24, get: (task) => names(task.assignees, 'username', 'email') },
  etiquetas: { width: 22, get: (task) => names(task.tags, 'name') },
  criacao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_created) },
  atualizacao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_updated) },
  inicial: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.start_date) },
  vencimento: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.due_date) },
  conclusao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_done) },
  encerramento: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_closed) },
};

/**
 * Nome de aba aceito pelo Excel: sem os caracteres proibidos, no máximo 31
 * caracteres e único no arquivo — nomes repetidos (ou que ficam iguais depois do
 * corte em 31) fazem o exceljs recusar a aba e a exportação inteira falhar.
 */
function sanitizeSheetName(name, usados) {
  const limpo = String(name || 'Tarefas')
    .replace(/[\\/*?:[\]]/g, '-')
    .trim();
  let candidato = limpo.slice(0, 31) || 'Tarefas';

  if (usados) {
    let sufixo = 2;
    while (usados.has(candidato.toLowerCase())) {
      const marca = ` (${sufixo++})`;
      candidato = `${limpo.slice(0, 31 - marca.length)}${marca}`;
    }
    usados.add(candidato.toLowerCase());
  }

  return candidato;
}

/**
 * Confere COLUNAS antes de o app começar a atender.
 *
 * Sem isto, um erro na configuração só aparecia quando alguém clicasse em
 * baixar — depois de push, CI verde e redeploy, com a tela funcionando. Pior:
 * errar o NOME da propriedade (`padrão` com acento, num arquivo todo acentuado)
 * não dava erro nenhum, a coluna simplesmente sumia da planilha em silêncio.
 */
export function validarColunas() {
  const problemas = [];

  COLUNAS.forEach((spec, i) => {
    const temPadrao = 'padrao' in spec;
    const temCampo = 'campo' in spec;
    const posicao = `COLUNAS[${i}] (${JSON.stringify(spec)})`;

    if (temPadrao === temCampo) {
      problemas.push(`${posicao}: precisa ter exatamente um entre "padrao" e "campo".`);
      return;
    }
    if (temPadrao && !LEITORES_PADRAO[spec.padrao]) {
      problemas.push(
        `${posicao}: "${spec.padrao}" não existe. Válidas: ${Object.keys(LEITORES_PADRAO).join(', ')}.`,
      );
    }
    if (temCampo && (typeof spec.campo !== 'string' || !spec.campo.trim())) {
      problemas.push(`${posicao}: "campo" tem que ser o nome do campo no ClickUp.`);
    }
  });

  return problemas;
}

/**
 * Colunas da aba, na ordem e com os títulos de COLUNAS (src/listas.js).
 *
 * `amostra` é a primeira página de tarefas. Na escrita em streaming as colunas
 * precisam estar definidas antes da primeira linha, então os campos herdados
 * (que aparecem na tarefa mas não na definição da lista) são descobertos por
 * essa amostra — na prática o conjunto de campos é o mesmo na lista inteira.
 */
function buildColumns(fieldDefinitions = [], amostra = []) {
  const { colunas: customFields, vistos } = collectCustomFields(fieldDefinitions, amostra);

  const colunaDeCampo = (definition) => ({
    fieldId: definition.id,
    header: definition.name || definition.id,
    width: 22,
    format: customFieldFormat(definition),
    get: (task) => {
      const field = (task.custom_fields || []).find((candidate) => candidate.id === definition.id);
      if (!field) return null;
      // A definição da lista traz o type_config completo; o da tarefa pode vir
      // resumido, então damos preferência ao da lista para resolver as opções.
      return formatCustomFieldValue({
        ...field,
        type: field.type || definition.type,
        type_config: definition.type_config || field.type_config,
      });
    },
  });

  // Um nome pode ter mais de uma definição (campo recriado no ClickUp mantém o
  // nome com id novo). Guardar só a última mandava a outra para o fim da aba,
  // com cabeçalho idêntico e origem diferente — numa planilha de CPF e valores,
  // duas colunas com o mesmo título e conteúdos distintos. Todas ficam juntas,
  // na posição configurada.
  const porNome = new Map();
  for (const definition of customFields) {
    const chave = String(definition.name || '').trim();
    if (!porNome.has(chave)) porNome.set(chave, []);
    porNome.get(chave).push(definition);
  }

  const usados = new Set();
  const colunas = [];

  for (const spec of COLUNAS) {
    if (spec.padrao) {
      const leitor = LEITORES_PADRAO[spec.padrao];
      if (!leitor) {
        throw new Error(
          `COLUNAS tem a chave padrão "${spec.padrao}", que não existe. ` +
            `Válidas: ${Object.keys(LEITORES_PADRAO).join(', ')}.`,
        );
      }
      colunas.push({ header: spec.titulo || spec.padrao, ...leitor });
      continue;
    }

    // Campo configurado que não existe nesta lista simplesmente não vira coluna.
    for (const definition of porNome.get(String(spec.campo).trim()) || []) {
      colunas.push(colunaDeCampo(definition));
      usados.add(definition.id);
    }
  }

  // Campo customizado que existe mas não foi listado entra no fim, em vez de
  // sumir: um campo novo no ClickUp aparece sem ninguém mexer no código.
  for (const definition of customFields) {
    if (!usados.has(definition.id)) colunas.push(colunaDeCampo(definition));
  }

  const repetidos = colunas
    .map((coluna) => coluna.header)
    .filter((header, i, todos) => todos.indexOf(header) !== i);
  if (repetidos.length) {
    // Não dá para renomear: o título tem que ser igual ao do ClickUp. Mas quem
    // for usar PROCV ou tabela dinâmica precisa saber que existe ambiguidade.
    console.warn(`[colunas] títulos repetidos na planilha: ${[...new Set(repetidos)].join(', ')}`);
  }

  return { colunas, vistos };
}

/**
 * Prepara uma aba: colunas fixadas, cabeçalho formatado e o escritor de linhas.
 *
 * Extraído para que a exportação sob demanda e a rodada que gera os dois
 * arquivos numa passada só compartilhem exatamente as mesmas travas — a de campo
 * que aparece tarde, principalmente. Duas cópias dessa lógica seria pedir para
 * uma delas envelhecer sem a proteção.
 */
function prepararAba(workbook, { list, fieldDefinitions = [], amostra = [], nomesUsados }) {
  const { colunas: columns, vistos } = buildColumns(fieldDefinitions, amostra);
  const sheet = workbook.addWorksheet(sanitizeSheetName(list?.name, nomesUsados), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns.map((column, index) => ({
    header: column.header,
    key: `c${index}`,
    width: column.width,
    style: column.format ? { numFmt: column.format } : undefined,
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B3A55' } };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;
  header.commit();

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  let total = 0;

  const escrever = (pagina) => {
    for (const task of pagina) {
      // As colunas são fixadas antes da primeira linha (streaming), a partir da
      // definição da lista mais a primeira página. Um campo preenchido só a
      // partir da tarefa 101 não teria coluna e sumiria da planilha sem aviso —
      // com dado de precatório, isso é inaceitável em silêncio.
      for (const campo of task.custom_fields || []) {
        // Excluído de propósito não é "desconhecido": sem esta checagem, um
        // campo oculto ou de botão que só aparecesse na segunda página abortava
        // a exportação alegando que ele não teria coluna.
        if (campo?.type === 'button' || CAMPOS_OCULTOS.includes(campo?.name)) continue;
        if (campo?.id && campo.value != null && campo.value !== '' && !vistos.has(campo.id)) {
          throw new Error(
            `Campo customizado "${campo.name || campo.id}" apareceu com valor fora das primeiras 100 tarefas ` +
              `da lista "${list?.name}" e não teria coluna. Exportação abortada para não entregar planilha incompleta.`,
          );
        }
      }

      sheet.addRow(columns.map((column) => column.get(task) ?? null)).commit();
      total++;
    }
  };

  return {
    escrever,
    commit: () => sheet.commit(),
    total: () => total,
    colunas: columns.length,
  };
}

function novoArquivo(filename) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'ClickUp Export';
  workbook.created = new Date();
  return workbook;
}

/**
 * Escreve, na MESMA passada de páginas, o arquivo completo e o só-em-aberto.
 *
 * Contar e exportar são o mesmo trabalho: as mesmas páginas, as mesmas
 * requisições. A única diferença é que uma escreve as linhas e a outra as
 * descarta. Aqui a passada rende as duas contagens e os dois arquivos, sem
 * nenhuma requisição a mais — as em aberto são um subconjunto das mesmas
 * páginas, então filtrar custa memória, não API.
 */
export async function writeListPair({
  list,
  fieldDefinitions = [],
  pages,
  caminhoCom,
  caminhoSem,
  concluida,
  onProgress,
}) {
  const arquivoCom = novoArquivo(caminhoCom);
  const arquivoSem = novoArquivo(caminhoSem);

  const iterator = pages[Symbol.asyncIterator]();
  const primeira = await iterator.next();
  const primeiraPagina = primeira.done ? [] : primeira.value;

  const abaCom = prepararAba(arquivoCom, { list, fieldDefinitions, amostra: primeiraPagina });
  const abaSem = prepararAba(arquivoSem, { list, fieldDefinitions, amostra: primeiraPagina });

  let com = 0;
  let sem = 0;
  let erro = null;

  const escrever = (pagina) => {
    const abertas = pagina.filter((task) => !concluida(task));
    // Os números são somados aqui, e não lidos das abas: se a escrita falhar no
    // meio, a contagem tem de sair certa mesmo assim.
    com += pagina.length;
    sem += abertas.length;

    if (!erro) {
      try {
        abaCom.escrever(pagina);
        abaSem.escrever(abertas);
      } catch (err) {
        // A trava de campo tardio existe para não entregar planilha incompleta,
        // e continua valendo — o arquivo é descartado por quem chamou. Mas ela
        // não pode levar a contagem junto: contar não entrega planilha nenhuma,
        // e sem isto uma lista nessa situação ficaria para sempre sem número.
        erro = err;
      }
    }

    onProgress?.({ com, sem });
  };

  escrever(primeiraPagina);
  if (!primeira.done) {
    for (let atual = await iterator.next(); !atual.done; atual = await iterator.next()) {
      escrever(atual.value);
    }
  }

  // Fecha os dois de qualquer jeito, inclusive quando a escrita falhou: sem o
  // commit, os descritores de arquivo do exceljs ficariam abertos.
  try {
    abaCom.commit();
    abaSem.commit();
    await arquivoCom.commit();
    await arquivoSem.commit();
  } catch (err) {
    erro = erro || err;
  }

  return { com, sem, erro };
}

/**
 * Escreve o .xlsx direto no disco, uma linha por vez, sem nunca segurar todas as
 * tarefas na memória.
 *
 * É o que torna viável exportar a pasta inteira: acumulando, as ~87 mil tarefas
 * da pasta passariam de 1,9 GB de pico. Cada aba recebe as páginas conforme elas
 * chegam da API e as descarrega no arquivo.
 *
 * `sheets` é uma lista de { list, fieldDefinitions, pages }, em que `pages` é um
 * async iterable de arrays de tarefas.
 */
export async function writeWorkbook({ filePath, sheets, onProgress }) {
  const workbook = novoArquivo(filePath);

  const resumo = [];
  const nomesUsados = new Set();

  for (const { list, fieldDefinitions = [], pages } of sheets) {
    const iterator = pages[Symbol.asyncIterator]();

    // A primeira página define as colunas, então precisa vir antes da aba.
    const primeira = await iterator.next();
    const primeiraPagina = primeira.done ? [] : primeira.value;

    const aba = prepararAba(workbook, {
      list,
      fieldDefinitions,
      amostra: primeiraPagina,
      nomesUsados,
    });

    const escrever = (pagina) => {
      aba.escrever(pagina);
      onProgress?.({ list, total: aba.total() });
    };

    escrever(primeiraPagina);
    if (!primeira.done) {
      for (let atual = await iterator.next(); !atual.done; atual = await iterator.next()) {
        escrever(atual.value);
      }
    }

    aba.commit();
    const total = aba.total();
    // O id vai junto do nome porque quem chama usa o resumo para guardar a
    // contagem real por lista — e duas listas podem ter o mesmo nome.
    resumo.push({ list: list?.name, listId: list?.id || null, tasks: total, columns: aba.colunas });
  }

  await workbook.commit();
  return resumo;
}

/** Nome de arquivo seguro, no padrão NOME-DA-LISTA_2026-07-30.xlsx */
export function buildFileName(nome) {
  const slug = String(nome || 'tarefas')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase() || 'TAREFAS';
  const today = new Date().toISOString().slice(0, 10);
  return `${slug}_${today}.xlsx`;
}
