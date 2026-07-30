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

function challenge(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="ClickUp Export", charset="UTF-8"');
  res.status(401).type('text/plain; charset=utf-8').send('Acesso restrito. Informe usuário e senha.');
}

/** Middleware de HTTP Basic Auth com um único usuário vindo do ambiente. */
export function basicAuth(req, res, next) {
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
    req.authenticatedUser = user;
    return next();
  }

  return challenge(res);
}
