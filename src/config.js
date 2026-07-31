import 'dotenv/config';
import { PASTA_PADRAO, IDS_PADRAO } from './listas.js';

function bool(name, fallback = false) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'sim';
}

function ids(name) {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  clickupToken: (process.env.CLICKUP_TOKEN || '').trim(),

  // Por padrão, a pasta e as listas fixas de src/listas.js. As variáveis abaixo
  // existem para sobrescrever isso sem mexer no código.
  folderId: (process.env.CLICKUP_FOLDER_ID || PASTA_PADRAO).trim(),
  listIds: ids('CLICKUP_LIST_IDS'),
  // Ids permitidos dentro da pasta. Vazio = todas as listas da pasta.
  // O recorte fixo só vale para a pasta a que ele pertence: apontar para outra
  // pasta mostra todas as listas dela, senão o filtro esvaziaria a tela.
  idsPermitidos:
    !bool('CLICKUP_ALL_LISTS', false) &&
    (process.env.CLICKUP_FOLDER_ID || PASTA_PADRAO).trim() === PASTA_PADRAO
      ? IDS_PADRAO
      : [],
  teamId: (process.env.CLICKUP_TEAM_ID || '').trim(),

  includeArchived: bool('CLICKUP_INCLUDE_ARCHIVED', false),
  includeClosed: bool('CLICKUP_INCLUDE_CLOSED', true),
  includeSubtasks: bool('CLICKUP_INCLUDE_SUBTASKS', true),

  authUser: process.env.AUTH_USER || '',
  authPassword: process.env.AUTH_PASSWORD || '',

  // Freio de força bruta no login.
  authFailureDelayMs: Number(process.env.AUTH_FAILURE_DELAY_MS ?? 250),
  authMaxDelayMs: Number(process.env.AUTH_MAX_DELAY_MS ?? 5000),
  authMaxFailures: Number(process.env.AUTH_MAX_FAILURES ?? 20),
  authBlockMs: Number(process.env.AUTH_BLOCK_SECONDS ?? 300) * 1000,
  authWindowMs: Number(process.env.AUTH_WINDOW_SECONDS ?? 900) * 1000,

  // Só ligue atrás de um proxy reverso de confiança: com isso o app passa a
  // acreditar no X-Forwarded-For, que qualquer cliente pode forjar se o app
  // estiver exposto direto.
  trustProxy: (process.env.TRUST_PROXY || '').toLowerCase() === 'true',

  appTitle: process.env.APP_TITLE || 'Negócios Precatório',
  port: Number(process.env.PORT || 3000),
  listsCacheSeconds: Number(process.env.LISTS_CACHE_SECONDS ?? 60),
  exportCacheSeconds: Number(process.env.EXPORT_CACHE_SECONDS ?? 300),
};

/** Retorna a lista de problemas de configuração (vazia = tudo certo). */
export function configProblems() {
  const problems = [];
  if (!config.clickupToken) {
    problems.push('CLICKUP_TOKEN não definido — pegue o token em ClickUp > Settings > Apps > API Token.');
  }
  if (!config.folderId && !config.listIds.length) {
    problems.push('Sem escopo: defina CLICKUP_FOLDER_ID ou CLICKUP_LIST_IDS, ou preencha src/listas.js.');
  }
  if (!config.authUser || !config.authPassword) {
    problems.push('AUTH_USER e/ou AUTH_PASSWORD não definidos — sem eles o app ficaria aberto na internet.');
  }
  return problems;
}
