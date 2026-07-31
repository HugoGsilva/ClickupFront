import ExcelJS from 'exceljs';
import { ORDEM_DOS_CAMPOS, CAMPOS_OCULTOS, COLUNAS_PADRAO } from './listas.js';

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

  // Ordem definida em src/listas.js. Quem não está lá vai para o fim, em vez de
  // sumir — assim um campo novo no ClickUp aparece na planilha sem ninguém
  // precisar lembrar de atualizar a lista.
  const posicao = (definition) => {
    const indice = ORDEM_DOS_CAMPOS.indexOf(definition.name);
    return indice === -1 ? ORDEM_DOS_CAMPOS.length : indice;
  };

  encontrados.sort((a, b) => posicao(a) - posicao(b));

  // `vistos` inclui o que foi deixado de fora de propósito (button e
  // CAMPOS_OCULTOS). Sem essa separação, esconder um campo o tornava
  // "desconhecido" e a trava de campo tardio abortava toda exportação em que
  // ele tivesse valor — ou seja, a funcionalidade nascia quebrada.
  return { colunas: encontrados, vistos };
}

/**
 * Como cada coluna padrão é lida da tarefa. A chave vem de COLUNAS_PADRAO, em
 * src/listas.js, que decide quais entram, em que ordem e com que título.
 *
 * Sobre as duas datas de fim: o ClickUp tem `date_done` (concluída) e
 * `date_closed` (fechada), e elas não coincidem — nas tarefas reais desta pasta
 * a primeira vem preenchida em 95% e a segunda em 1,5%. Exportar só uma
 * deixaria a coluna praticamente vazia.
 */
const LEITORES_PADRAO = {
  nome: { width: 45, get: (task) => truncate(task.name || '') },
  id: { width: 14, get: (task) => task.id || '' },
  status: { width: 18, get: (task) => task.status?.status || '' },
  responsaveis: { width: 24, get: (task) => names(task.assignees, 'username', 'email') },
  etiquetas: { width: 22, get: (task) => names(task.tags, 'name') },
  criacao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_created) },
  atualizacao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_updated) },
  inicio: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.start_date) },
  vencimento: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.due_date) },
  conclusao: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_done) },
  fechamento: { width: 18, format: FORMATS.datetime, get: (task) => toExcelDate(task.date_closed) },
};

function standardColumns() {
  return COLUNAS_PADRAO.map(({ chave, titulo }) => {
    const leitor = LEITORES_PADRAO[chave];
    if (!leitor) {
      throw new Error(
        `COLUNAS_PADRAO tem a chave "${chave}", que não existe. Chaves válidas: ${Object.keys(LEITORES_PADRAO).join(', ')}.`,
      );
    }
    return { header: titulo, ...leitor };
  });
}

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
 * Colunas da aba: padrão + uma por campo customizado + descrição e link no fim.
 *
 * `amostra` é a primeira página de tarefas. Na escrita em streaming as colunas
 * precisam estar definidas antes da primeira linha, então os campos herdados
 * (que aparecem na tarefa mas não na definição da lista) são descobertos por
 * essa amostra — na prática o conjunto de campos é o mesmo na lista inteira.
 */
function buildColumns(fieldDefinitions = [], amostra = []) {
  const { colunas: customFields, vistos } = collectCustomFields(fieldDefinitions, amostra);

  const customColumns = customFields.map((definition) => {
    return {
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
    };
  });

  return { colunas: [...standardColumns(), ...customColumns], vistos };
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
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: false,
  });
  workbook.creator = 'ClickUp Export';
  workbook.created = new Date();

  const resumo = [];
  const nomesUsados = new Set();

  for (const { list, fieldDefinitions = [], pages } of sheets) {
    const iterator = pages[Symbol.asyncIterator]();

    // A primeira página define as colunas, então precisa vir antes da aba.
    const primeira = await iterator.next();
    const primeiraPagina = primeira.done ? [] : primeira.value;

    const { colunas: columns, vistos } = buildColumns(fieldDefinitions, primeiraPagina);
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

    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };

    let total = 0;
    const conhecidos = vistos;

    const escrever = (pagina) => {
      for (const task of pagina) {
        // As colunas são fixadas antes da primeira linha (streaming), a partir
        // da definição da lista mais a primeira página. Um campo preenchido só
        // a partir da tarefa 101 não teria coluna e sumiria da planilha sem
        // aviso — com dado de precatório, isso é inaceitável em silêncio.
        for (const campo of task.custom_fields || []) {
          if (campo?.id && campo.value != null && campo.value !== '' && !conhecidos.has(campo.id)) {
            throw new Error(
              `Campo customizado "${campo.name || campo.id}" apareceu com valor fora das primeiras 100 tarefas ` +
                `da lista "${list?.name}" e não teria coluna. Exportação abortada para não entregar planilha incompleta.`,
            );
          }
        }

        sheet.addRow(columns.map((column) => column.get(task) ?? null)).commit();
        total++;
      }
      onProgress?.({ list, total });
    };

    escrever(primeiraPagina);
    if (!primeira.done) {
      for (let atual = await iterator.next(); !atual.done; atual = await iterator.next()) {
        escrever(atual.value);
      }
    }

    sheet.commit();
    resumo.push({ list: list?.name, tasks: total, columns: columns.length });
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
