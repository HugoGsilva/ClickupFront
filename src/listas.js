/**
 * Escopo fixo do app: a pasta e as listas que aparecem na tela.
 *
 * Está no código, e não em variável de ambiente, porque são muitas e mudam
 * pouco — assim o deploy não depende de uma variável gigante no Portainer.
 * Ids conferidos contra a API em 31/07/2026.
 *
 * Para incluir ou remover um nome, edite a lista abaixo e faça push: o CI
 * publica a imagem nova e basta um "Pull and redeploy" no Portainer.
 *
 * A ordem daqui é a ordem que aparece na tela.
 */
export const PASTA_PADRAO = '90132214702'; // Negocios Precatorio

export const LISTAS_PADRAO = [
  { id: '901312077354', nome: 'DIVANEIDE' },
  { id: '901317298786', nome: 'ANA CAROLINA' },
  { id: '901312077328', nome: 'SUED' },
  { id: '901305112832', nome: 'JAQUELINE' },
  { id: '901306564880', nome: 'KLEIDSON' },
  { id: '901327135331', nome: 'DAYANE' },
  { id: '901305172984', nome: 'JESSICA' },
  { id: '901326678749', nome: 'AMANDA' },
  { id: '901326678752', nome: 'ELIVÂNIA' },
  { id: '901326678520', nome: 'ANA JULIA' },
  { id: '901326678746', nome: 'KATLYN' },
  { id: '901327413544', nome: 'ESTER' },
  { id: '901327413560', nome: 'DERICK' },
  { id: '901327413570', nome: 'POLLYANA' },
  { id: '901327427455', nome: 'EDUARDA GABRYELA' },
  { id: '901327427537', nome: 'DAYARA' },
  { id: '901307459115', nome: 'DIVINO' },
  { id: '901306307780', nome: 'JOSE' },
  { id: '901305113532', nome: 'GENARIO' },
];

export const IDS_PADRAO = LISTAS_PADRAO.map((lista) => lista.id);
