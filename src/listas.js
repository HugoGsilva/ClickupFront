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
 * Colunas padrão da tarefa: quais entram e com que título.
 *
 * O título tem que ser igual ao do ClickUp — é o que a equipe reconhece. Se
 * algum estiver diferente do que aparece aí, corrija SÓ o `titulo`: a `chave` é
 * o que liga à API e não deve mudar.
 *
 * Para tirar uma coluna, comente ou apague a linha. Para reordenar, mude a
 * ordem — elas saem antes dos campos customizados, nesta sequência.
 */
export const COLUNAS_PADRAO = [
  { chave: 'nome', titulo: 'Nome da tarefa' },
  { chave: 'id', titulo: 'ID da tarefa' },
  { chave: 'status', titulo: 'Status' },
  { chave: 'responsaveis', titulo: 'Responsáveis' },
  { chave: 'etiquetas', titulo: 'Etiquetas' },
  { chave: 'criacao', titulo: 'Data de criação' },
  { chave: 'atualizacao', titulo: 'Data da última atualização' },
  { chave: 'inicio', titulo: 'Data de início' },
  { chave: 'vencimento', titulo: 'Data de vencimento' },
  { chave: 'conclusao', titulo: 'Data de conclusão' },
  { chave: 'fechamento', titulo: 'Data de fechamento' },
];

/**
 * Campos customizados que NÃO devem virar coluna.
 *
 * Por padrão todo campo customizado é exportado, inclusive os que vêm sempre
 * vazios — a planilha reflete a estrutura da lista. Quem entrar aqui fica de
 * fora. Use o nome exato como aparece no ClickUp.
 */
export const CAMPOS_OCULTOS = [
  // Botão da interface do ClickUp: não carrega dado. Campos do tipo `button` já
  // ficam de fora automaticamente; está aqui para o caso de mudar de tipo.
  'Msg Proposta Pronta',
];

/**
 * Ordem das colunas de campo customizado na planilha.
 *
 * É a ordem que aparece no ClickUp: primeiro os campos da própria lista, depois
 * os herdados. Campo customizado que não esteja aqui não é descartado — entra no
 * fim, para nenhuma informação sumir sem aviso.
 *
 * Para reordenar as colunas, basta mudar a ordem desta lista.
 */
export const ORDEM_DOS_CAMPOS = [
  '03 - CPF',
  '02 - Telefone',
  '04 - NrProcesso',
  '01 - Ação',
  '05 - Cidade',
  '06 - UF',
  '07 - Valor Bruto',
  '08 - Valor Liquido',
  '09 - Valor Proposta',
  '10 - Valor Fechado',
  '11 - Fundo',
  '12 - Honorários destacados?',
  '13 - Data de Encerramento',
  '14 - Intermediação',
  '15 - Comissão',
  'Juridíco',
  '16 - Data de Expedição',
  'Ação Coletiva?',
  'Previdenciário?',
];
