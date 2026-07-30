# ClickUp → Excel

Front-end protegido por Basic Auth para baixar as tarefas de uma pasta do ClickUp
em planilha `.xlsx`, **com os campos padrão e todos os campos customizados**.

Uma tela só: a pessoa loga, procura o nome (DIVANEIDE, ANA CAROLINA, SUED…) e
clica em *Baixar Excel*.

## Como funciona

```
Navegador ──Basic Auth──▶ Node/Express ──token pk_──▶ API do ClickUp
                               │
                               └── monta o .xlsx e devolve o download
```

O token do ClickUp fica **só no servidor**. Ele nunca chega ao navegador — se
fosse um front puro, qualquer pessoa com o DevTools aberto teria acesso total à
conta do ClickUp.

## Configuração

Copie `.env.example` para `.env` e preencha:

| Variável | O que é |
| --- | --- |
| `CLICKUP_TOKEN` | Token pessoal da API. ClickUp > Settings > Apps > *API Token*. Começa com `pk_`. |
| `CLICKUP_FOLDER_ID` | Id da pasta "Negócios Precatório". Abra a pasta no ClickUp e pegue da URL: `.../v/f/<ID-DA-PASTA>/...` |
| `AUTH_USER` / `AUTH_PASSWORD` | Usuário e senha do login do navegador. |
| `CLICKUP_INCLUDE_CLOSED` | `true` inclui tarefas concluídas (padrão). |
| `CLICKUP_INCLUDE_SUBTASKS` | `true` inclui subtarefas (padrão). |
| `CLICKUP_INCLUDE_ARCHIVED` | `true` inclui itens arquivados (padrão `false`). |
| `APP_TITLE` | Título mostrado no topo. |
| `TZ` | Fuso usado nas datas da planilha (padrão `America/Sao_Paulo`). |
| `PORT` | Porta do servidor (padrão `3000`). |

## Rodando local

```bash
npm install
cp .env.example .env   # preencha o token, a pasta e a senha
npm start              # http://localhost:3000
```

## Deploy no Portainer

1. **Stacks > Add stack > Web editor** e cole o conteúdo de `docker-compose.yml`.
2. Na seção **Environment variables**, cadastre:
   `CLICKUP_TOKEN`, `CLICKUP_FOLDER_ID`, `AUTH_USER`, `AUTH_PASSWORD`
   (e `PORT` se quiser publicar em outra porta).
3. **Deploy the stack**.

O compose usa `build: .`, então o Portainer precisa do repositório
(*Repository* em vez de *Web editor*, apontando para este projeto). Se preferir
usar uma imagem já publicada, troque `build: .` por `image: ...` no compose.

Health check em `GET /health` — único endpoint que responde sem autenticação,
para o Docker conseguir monitorar o container.

> Coloque o container atrás de HTTPS (Traefik, Nginx Proxy Manager, Cloudflare).
> Basic Auth manda usuário e senha em base64, que é reversível: sem TLS, a senha
> trafega praticamente aberta.

## O que sai na planilha

Uma aba, uma linha por tarefa. Colunas, nesta ordem:

1. **Padrão** — ID, ID customizado (quando existe), Nome, Status, Prioridade,
   Responsáveis, Tags, Criada em, Atualizada em, Início, Prazo, Concluída em,
   Tempo estimado (h), Tempo gasto (h), Lista, Tarefa pai, Criada por.
2. **Todos os campos customizados da lista**, na ordem definida no ClickUp.
3. Descrição e Link.

Os valores vêm convertidos, não crus: `drop_down` mostra o nome da opção (e não
o id), `labels` vira a lista de etiquetas separada por vírgula, `checkbox` vira
Sim/Não, datas viram data de verdade (dá para ordenar e filtrar), moeda e número
viram número (dá para somar). Cabeçalho congelado e autofiltro já vêm ligados.

Um campo customizado que apareça nas tarefas mas não na definição da lista
(herdado de outro nível) também vira coluna, no fim do bloco de customizados.

## Somente leitura

O app **nunca escreve no ClickUp**. Isso não é uma promessa no README, é uma
trava no código: toda chamada à API passa por `safeFetch` (`src/clickup.js`), que
recusa qualquer método diferente de `GET`, recusa requisição com corpo e recusa
destino fora da API do ClickUp. Um bug futuro, um copy-paste infeliz ou um id
malicioso não conseguem criar, editar nem apagar nada.

Os testes provam os dois lados: que as travas rejeitam `POST`/`PUT`/`PATCH`/
`DELETE`, e que uma exportação completa não gerou nenhuma requisição de escrita.

## Listas grandes

A API do ClickUp devolve 100 tarefas por requisição e limita 100 requisições por
minuto. Uma lista de 17 mil tarefas são ~170 requisições, uns 2 minutos. O app:

- mostra o progresso na linha (`1.200 de ~17.083 tarefas`);
- espera e repete sozinho quando toma rate limit (429), em vez de falhar;
- guarda o arquivo gerado por 5 minutos — baixar a mesma lista de novo é instantâneo.

## Diagnóstico (conferir os campos sem expor dados)

```bash
npm run diagnostico                     # primeira lista da pasta
npm run diagnostico -- --lista 901234   # uma lista específica
npm run diagnostico -- --amostra 20     # quantas tarefas analisar
```

Roda na sua máquina, com o seu token, e imprime um relatório do **formato** dos
campos — nome, tipo, quantos vêm preenchidos e como cada um sai na planilha —
com os **valores mascarados** (`texto ✓ (14 caracteres)` no lugar do CPF,
`número ✓` no lugar do valor). Serve para validar a conversão e para pedir ajuda
sem vazar nada: o relatório pode ser compartilhado como está.

Também confirma se `CLICKUP_TOKEN` e `CLICKUP_FOLDER_ID` estão certos e lista os
ids de todas as listas da pasta.

Existe a flag `--sem-mascara`, que imprime os valores reais. É só para conferir
localmente — o resultado **não** deve ser compartilhado.

## Testes

```bash
npm test
```

Sobe um ClickUp falso (`test/fake-clickup.js`) e testa ponta a ponta: Basic Auth,
listagem, paginação acima de 100 tarefas, cache e o conteúdo real do `.xlsx`
gerado — incluindo a conversão de cada tipo de campo customizado. Não precisa de
token nem de internet.

## Estrutura

```
src/config.js    variáveis de ambiente e validação
src/auth.js      Basic Auth (comparação em tempo constante)
src/clickup.js   cliente da API, paginação e retry de rate limit
src/excel.js     montagem da planilha e conversão dos campos customizados
src/server.js    rotas, cache e progresso
public/          a tela (HTML, CSS e JS puros, sem build)
```
