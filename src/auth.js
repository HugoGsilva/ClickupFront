import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Comparação em tempo constante, imune a diferença de tamanho. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Ainda assim compara, para não vazar o tamanho da senha pelo tempo de resposta.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Freio de força bruta
//
// A credencial é única, estática e compartilhada: sem freio, dá para tentar
// senhas na velocidade da rede até acertar — e quem acerta baixa CPFs e valores
// de precatório. O freio tem duas camadas:
//
//   1. atraso progressivo a cada falha do mesmo IP (dobra, até o teto). Quem
//      erra a senha uma vez nem percebe; um script cai para poucas tentativas
//      por minuto.
//   2. bloqueio temporário depois de muitas falhas, respondendo 429.
//
// Acerto limpa o histórico do IP na hora, então errar a senha e corrigir não
// deixa resíduo.
// ---------------------------------------------------------------------------
const failures = new Map(); // ip -> { count, firstAt, blockedUntil }

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function prune(now) {
  for (const [ip, entry] of failures) {
    const expired = now - entry.firstAt > config.authWindowMs && (entry.blockedUntil || 0) < now;
    if (expired) failures.delete(ip);
  }
}

function registerFailure(ip, now) {
  const entry = failures.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > config.authWindowMs) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count++;
  if (entry.count >= config.authMaxFailures) {
    entry.blockedUntil = now + config.authBlockMs;
  }
  failures.set(ip, entry);
  return entry;
}

function challenge(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="ClickUp Export", charset="UTF-8"');
  res.status(401).type('text/plain; charset=utf-8').send('Acesso restrito. Informe usuário e senha.');
}

/** Middleware de HTTP Basic Auth com um único usuário vindo do ambiente. */
export async function basicAuth(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || 'desconhecido';
  prune(now);

  const entry = failures.get(ip);
  if (entry?.blockedUntil > now) {
    const segundos = Math.ceil((entry.blockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(segundos));
    return res
      .status(429)
      .type('text/plain; charset=utf-8')
      .send(`Tentativas demais. Tente de novo em ${segundos} segundos.`);
  }

  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('basic ')) return challenge(res);

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return challenge(res);
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return challenge(res);

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  // Os dois testes rodam sempre, sem curto-circuito, para não vazar qual dos
  // dois estava errado através do tempo de resposta.
  const userOk = safeEqual(user, config.authUser);
  const passOk = safeEqual(password, config.authPassword);

  if (userOk && passOk) {
    failures.delete(ip);
    req.authenticatedUser = user;
    return next();
  }

  const registro = registerFailure(ip, now);
  console.warn(`[auth] falha de login de ${ip} (${registro.count} no período)`);

  // Atraso progressivo: 1ª falha = base, 2ª = o dobro, e assim por diante.
  const atraso = Math.min(config.authFailureDelayMs * 2 ** (registro.count - 1), config.authMaxDelayMs);
  await sleep(atraso);

  return challenge(res);
}

/** Só para os testes: zera o histórico de falhas. */
export function resetFailures() {
  failures.clear();
}
