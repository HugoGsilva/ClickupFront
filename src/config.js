import 'dotenv/config';

function bool(name, fallback = false) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'sim';
}

export const config = {
  clickupToken: (process.env.CLICKUP_TOKEN || '').trim(),
  folderId: (process.env.CLICKUP_FOLDER_ID || '').trim(),

  includeArchived: bool('CLICKUP_INCLUDE_ARCHIVED', false),
  includeClosed: bool('CLICKUP_INCLUDE_CLOSED', true),
  includeSubtasks: bool('CLICKUP_INCLUDE_SUBTASKS', true),

  authUser: process.env.AUTH_USER || '',
  authPassword: process.env.AUTH_PASSWORD || '',

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
  if (!config.folderId) {
    problems.push('CLICKUP_FOLDER_ID não definido — é o id da pasta "Negócios Precatório".');
  }
  if (!config.authUser || !config.authPassword) {
    problems.push('AUTH_USER e/ou AUTH_PASSWORD não definidos — sem eles o app ficaria aberto na internet.');
  }
  return problems;
}
