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

/**
 * Campos customizados que NÃO devem virar coluna, nem no fim da planilha.
 *
 * Um campo que exista no ClickUp e não esteja em COLUNAS entra no fim, para
 * nada sumir sem querer. Quem entrar aqui fica de fora de vez. Use o nome
 * exato como aparece no ClickUp.
 */
export const CAMPOS_OCULTOS = [
  // Botão da interface do ClickUp: não carrega dado. Campos do tipo `button` já
  // ficam de fora automaticamente; está aqui para o caso de mudar de tipo.
  'Msg Proposta Pronta',
];

/**
 * As colunas da planilha, na ordem e com os títulos do ClickUp.
 *
 * Copiada do seletor de colunas do ClickUp: mesma sequência, mesmos nomes. É o
 * único lugar a mexer para mudar a planilha.
 *
 *   { padrao: 'chave' }  -> coluna da própria tarefa. A chave liga ao leitor em
 *                           src/excel.js e NÃO muda; só o título é livre.
 *   { campo: 'Nome' }    -> campo customizado, casado pelo nome exato do ClickUp.
 *
 * Campo customizado que exista nas tarefas e não esteja aqui não é descartado:
 * entra no fim. Assim um campo novo criado no ClickUp aparece sozinho.
 */
export const COLUNAS = [
  { padrao: 'nome', titulo: 'Nome da tarefa' },

  { campo: '03 - CPF' },
  { campo: '02 - Telefone' },
  { campo: '04 - NrProcesso' },
  { campo: '01 - Ação' },
  { campo: '05 - Cidade' },
  { campo: '07 - Valor Bruto' },
  { campo: '06 - UF' },
  { campo: '08 - Valor Liquido' },
  { campo: '09 - Valor Proposta' },
  { campo: '10 - Valor Fechado' },
  { campo: '11 - Fundo' },
  { campo: '12 - Honorários destacados?' },
  { campo: '13 - Data de Encerramento' },
  { campo: '14 - Intermediação' },
  { campo: 'Juridíco' },
  { campo: '15 - Comissão' },
  { campo: 'Ação Coletiva?' },
  { campo: 'Previdenciário?' },
  { campo: '16 - Data de Expedição' },

  { padrao: 'etiquetas', titulo: 'Etiquetas' },
  { padrao: 'criacao', titulo: 'Data criada' },
  { padrao: 'atualizacao', titulo: 'Data de atualização' },
  { padrao: 'conclusao', titulo: 'Data de conclusão' },
  { padrao: 'encerramento', titulo: 'Data de encerramento' },
  { padrao: 'vencimento', titulo: 'Data de vencimento' },
  { padrao: 'inicial', titulo: 'Data inicial' },
  { padrao: 'responsavel', titulo: 'Responsável' },
  { padrao: 'id', titulo: 'ID da tarefa' },
  { padrao: 'status', titulo: 'Status' },
];

