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
| `CLICKUP_FOLDER_ID` | Id da pasta a exibir — mostra todas as listas dela. |
| `CLICKUP_LIST_IDS` | Alternativa à pasta: ids de listas específicas, separados por vírgula. |
| `CLICKUP_TEAM_ID` | Só para o `npm run descobrir`. É o primeiro número da URL do ClickUp. |
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

## CI: imagem publicada automaticamente

`.github/workflows/ci.yml` roda a cada push: primeiro os testes, e só se
passarem ele builda a imagem (amd64 e arm64) e publica no Docker Hub.

Configure uma vez, em **Settings > Secrets and variables > Actions**:

| Secret | Valor |
| --- | --- |
| `DOCKERHUB_USERNAME` | seu usuário do Docker Hub |
| `DOCKERHUB_TOKEN` | um *Access Token* criado em hub.docker.com > Account Settings > Personal access tokens (não use a senha da conta) |

Sem esses secrets o workflow ainda roda os testes; ele só avisa que não vai
publicar, em vez de falhar. Pull request nunca publica imagem.

Tags geradas: `latest` (branch padrão), o nome da branch, o sha curto e a versão
quando você criar uma tag `v*`.

## Deploy no Portainer (Docker Swarm + Traefik)

Use o **`docker-stack.yml`**: ele já vem com `deploy:`, a rede externa
`network_swarm_public` e as labels do Traefik para
`testeclickup.hugogsilva.dev` (entrypoint `websecure`, certificado pelo
`letsencryptresolver`). Também já liga `TRUST_PROXY=true`, porque com o Traefik
na frente é ele quem informa o IP real do cliente — sem isso o freio de força
bruta contaria todo mundo como um IP só.

**Stacks > Add stack > Web editor**, cole o arquivo e preencha em *Environment
variables*:

| Variável | Valor |
| --- | --- |
| `DOCKER_IMAGE` | `seuusuario/clickup-export:latest` |
| `CLICKUP_TOKEN` | o token `pk_...` |
| `CLICKUP_LIST_IDS` *ou* `CLICKUP_FOLDER_ID` | o escopo (veja *Achar os ids*) |
| `AUTH_USER` / `AUTH_PASSWORD` | o login da tela |

O limite de memória está em 1 GB, com folga: exportar a pasta inteira (21
listas, 89 mil tarefas) tem pico medido de 262 MB.

Para atualizar depois de um push novo: **Stacks > sua stack > Pull and redeploy**.

## Deploy com Docker simples (sem Swarm)

1. **Stacks > Add stack > Web editor** e cole o conteúdo de `docker-compose.yml`.
2. Na seção **Environment variables**, cadastre:

   | Variável | Valor |
   | --- | --- |
   | `DOCKER_IMAGE` | `seuusuario/clickup-export:latest` |
   | `CLICKUP_TOKEN` | o token `pk_...` |
   | `CLICKUP_FOLDER_ID` | o id da pasta |
   | `AUTH_USER` / `AUTH_PASSWORD` | o login da tela |
   | `PORT` | opcional, se 3000 estiver ocupada |

3. **Deploy the stack**.

Para atualizar depois de um push novo: **Stacks > sua stack > Pull and redeploy**.

Health check em `GET /health` — único endpoint que responde sem autenticação,
para o Docker conseguir monitorar o container.

> Coloque o container atrás de HTTPS (Traefik, Nginx Proxy Manager, Cloudflare).
> Basic Auth manda usuário e senha em base64, que é reversível: sem TLS, a senha
> trafega praticamente aberta.

## O que sai na planilha

Uma aba por lista, uma linha por tarefa. Nas listas da pasta Precatório são
**30 colunas** — os mesmos nomes e a mesma ordem do seletor do ClickUp. Uma
lista com outro conjunto de campos customizados gera menos colunas: as padrão
são sempre as mesmas, as customizadas dependem do que existe na lista.

```
Nome da tarefa · 03 - CPF · 02 - Telefone · 04 - NrProcesso · 01 - Ação
05 - Cidade · 07 - Valor Bruto · 06 - UF · 08 - Valor Liquido
09 - Valor Proposta · 10 - Valor Fechado · 11 - Fundo
12 - Honorários destacados? · 13 - Data de Encerramento · 14 - Intermediação
Juridíco · 15 - Comissão · Ação Coletiva? · Previdenciário?
16 - Data de Expedição · Etiquetas · Data criada · Data de atualização
Data de conclusão · Data de encerramento · Data de vencimento · Data inicial
Responsável · ID da tarefa · Status
```

Tudo isso vem de **`COLUNAS`**, em `src/listas.js` — uma lista só, na ordem da
planilha:

```js
{ padrao: 'nome', titulo: 'Nome da tarefa' },  // coluna da tarefa
{ campo: '03 - CPF' },                          // campo customizado, pelo nome
```

`padrao` liga a um leitor em `src/excel.js` e não muda; o `titulo` é livre, e é
onde se corrige um nome que esteja diferente do ClickUp.

A configuração é conferida **na subida do app**: chave inexistente, entrada sem
`padrao` nem `campo` (inclusive erro de digitação na propriedade, como `padrão`
com acento) ou `campo` vazio impedem o container de subir, com a mensagem
dizendo qual entrada e quais são as válidas. Antes isso passava batido e a
coluna simplesmente sumia da planilha, sem erro.

> O ClickUp tem **duas** datas de fim e elas não coincidem: `Data de conclusão`
> (`date_done`) e `Data de encerramento` (`date_closed`). Nas tarefas reais
> desta pasta, a primeira vem preenchida em 93% e a segunda em 4%. Por isso as
> duas saem.

`Prioridade` e `Msg Proposta Pronta` ficam de fora, a pedido.

Campo customizado vira coluna **mesmo quando está vazio em todas as tarefas** —
a planilha reflete a estrutura da lista, não só o que foi preenchido. Campo do
tipo `button` fica de fora: é ação de interface, não dado.

### Mudar as colunas

Tudo em **`src/listas.js`**, sem tocar na lógica:

| O que você quer | Onde mexer |
| --- | --- |
| Renomear uma coluna | mude o `titulo` (colunas padrão) — campo customizado usa o nome do ClickUp |
| Tirar uma coluna | apague a linha dela em `COLUNAS` |
| Reordenar | mude a ordem em `COLUNAS` |
| Nunca exportar um campo | acrescente o nome em `CAMPOS_OCULTOS` |
| Incluir um campo novo do ClickUp | **nada** — ele aparece sozinho, no fim |

Campo customizado que exista nas tarefas e não esteja em `COLUNAS` não é
descartado: entra no fim. Assim um campo novo criado no ClickUp aparece na
planilha sem ninguém precisar lembrar de atualizar o código.

Colunas padrão que ainda não têm leitor (Prioridade, Descrição, Link…) precisam
de uma linha em `LEITORES_PADRAO`, em `src/excel.js`.

Depois de editar: `git push` → o CI publica a imagem → *Pull and redeploy* no
Portainer.

Os valores vêm convertidos, não crus: `drop_down` mostra o nome da opção (e não
o id), `labels` vira a lista de etiquetas separada por vírgula, `checkbox` vira
Sim/Não, datas viram data de verdade (dá para ordenar e filtrar), moeda e número
viram número (dá para somar). Cabeçalho congelado e autofiltro já vêm ligados.

## Somente leitura

O app **nunca escreve no ClickUp**. Não é uma promessa no README, é uma trava no
código: toda chamada à API passa por `safeFetch` (`src/clickup.js`), e a linha
que importa é esta:

```js
return fetch(target, { ...options, method: 'GET', body: undefined });
```

As chaves literais vêm **depois** do spread, então vencem sempre. Mesmo que
alguém consiga enganar as validações acima, o método que sai na rede continua
sendo `GET`. Antes disso, a trava ainda recusa qualquer método diferente de
`GET`, recusa requisição com corpo, e recusa destino que não caia dentro da API
do ClickUp — comparando a URL **já normalizada**, origem e prefixo de caminho,
para que nem travessia (`/api/v2/../../x`) nem host colado
(`api.clickup.com.outra-coisa.com`) passem.

Ids que entram no caminho da URL são validados contra `[A-Za-z0-9_-]+`, e o id
de lista que vem do navegador é conferido contra as listas da pasta configurada
antes de qualquer uso.

`CLICKUP_API_BASE` existe só para os testes apontarem para um ClickUp falso e
**só aceita 127.0.0.1** — qualquer outro valor é ignorado com um aviso. Sem esse
limite ele seria um desvio silencioso: a trava compara o destino com essa mesma
variável, então trocá-la mandaria o token para o host escolhido.

Os testes cobrem os dois lados: as travas rejeitam `POST`/`PUT`/`PATCH`/`DELETE`,
travessia de caminho, host colado e credenciais na URL — e uma exportação
completa não gera nenhuma requisição de escrita (o ClickUp falso registra tudo
que recebe).

> O que a trava **não** protege é o token em si. Um token pessoal `pk_` do
> ClickUp não tem escopo: quem conseguir lê-lo (pela UI do Portainer, por
> `docker inspect`, por acesso ao container) escreve no ClickUp à vontade, por
> fora deste app. Trate a variável como senha de administrador.

## Proteção do login

A credencial é única e compartilhada, então o login tem freio contra força
bruta (`src/auth.js`): cada erro do mesmo IP dobra o atraso da resposta (até 5 s)
e, passando de `AUTH_MAX_FAILURES`, o IP recebe `429` com `Retry-After` por
`AUTH_BLOCK_SECONDS`. Acertar a senha limpa o histórico na hora, e toda falha
é registrada no log. A comparação de usuário e senha é em tempo constante.

`TRUST_PROXY` vem desligado: só ligue se houver um proxy reverso de confiança na
frente. Ligado sem proxy, qualquer cliente forja o `X-Forwarded-For` e escapa do
freio.

## Volume

O botão **Baixar tudo** exporta a pasta inteira num arquivo só, uma aba por
lista. Medido com a pasta do print (21 listas, 89.011 tarefas):

| | |
| --- | --- |
| Pico de memória | **262 MB** |
| CPU para montar | 10,5 s |
| Arquivo final | 11,2 MB |

O que segura a memória é a escrita em streaming (`writeWorkbook`, em
`src/excel.js`): cada página que chega da API vira linha no arquivo e é
descartada. Acumulando tudo antes de escrever, as mesmas 89 mil tarefas passariam
de 1,9 GB — sozinha, uma lista de 17 mil já custava 364 MB.

O tempo, esse não tem jeito: a API devolve **100 tarefas por requisição** e o
token é limitado a **100 requisições por minuto**. Medido contra a API real:
**~117 tarefas por segundo**, o que dá uns **13 minutos** para a pasta inteira.
JESSICA (18.283 tarefas contando subtarefas) levou 2m42s; DIVANEIDE (2.443), 21
segundos.

O que o app faz para isso não virar problema:

- **A requisição HTTP não fica aberta esperando.** O navegador dispara a
  geração, recebe `202` na hora e acompanha pelo progresso; quando termina, pede
  o arquivo, que sai do cache instantaneamente. Sem isso, qualquer intermediário
  com teto de resposta — a Cloudflare corta em 100 s — mataria a conexão no meio
  de toda exportação grande.
- **Orçamento de requisições compartilhado** (`src/clickup.js`): todas as
  exportações do processo passam por uma fila única que se mantém abaixo do
  limite do token. Antes, alguém clicando em "Baixar Excel" durante um "Baixar
  tudo" empurrava os dois para 429 e podia matar a exportação longa. Ajustável
  por `CLICKUP_REQS_POR_MINUTO` (padrão 90).
- Mostra o progresso (`JAQUELINE (4/19) · 12.400 de ~92.511 tarefas`).
- Espera e repete sozinho quando ainda assim toma 429.
- Guarda o arquivo por 5 minutos — baixar de novo é instantâneo.
- Dois cliques na mesma coisa compartilham a mesma geração.
- **Recusa entregar planilha incompleta**: se vierem menos tarefas do que o
  ClickUp informa, a exportação falha em vez de devolver um arquivo truncado que
  parece completo. Conferido contra 35.625 tarefas reais — a margem é folgada,
  porque o `task_count` não conta subtarefas e o lido fica sempre acima.
  Desligável por `VERIFICAR_CONTAGEM=false`.

## Escopo: as listas que aparecem

O padrão vem fixo em **`src/listas.js`** — a pasta Negócios Precatório e os 19
nomes que devem aparecer na tela, nessa ordem. Está no código, e não em variável
de ambiente, porque são muitos e mudam pouco: assim o Portainer não precisa de
uma variável gigante.

**Para incluir ou remover um nome**: edite `src/listas.js`, faça push, e depois
*Pull and redeploy* no Portainer. O CI publica a imagem nova sozinho.

Custa **uma** requisição: o app busca a pasta inteira (que já vem com as
contagens) e faz o recorte em memória. Se um id do arquivo não estiver mais na
pasta, o app avisa no log em vez de quebrar.

Dá para sobrescrever sem tocar no código:

| Variável | Efeito |
| --- | --- |
| `CLICKUP_ALL_LISTS=true` | mostra todas as listas da pasta, ignorando o recorte |
| `CLICKUP_FOLDER_ID=<outra>` | aponta para outra pasta (o recorte fixo não se aplica a ela) |
| `CLICKUP_LIST_IDS=<a,b,c>` | listas avulsas, de qualquer pasta |

> A contagem que aparece ao lado de cada nome é o `task_count` do ClickUp, que
> **não inclui subtarefas**. Como a exportação inclui, a planilha costuma ter
> algumas linhas a mais — em DIVINO, 135 na tela e 137 na planilha. Verificado:
> com `CLICKUP_INCLUDE_SUBTASKS=false` os dois números batem.

## Achar os ids

```bash
npm run descobrir
```

Imprime a árvore do time — espaços, pastas e listas, com os ids que o app usa.
Precisa só de `CLICKUP_TOKEN` e `CLICKUP_TEAM_ID` no `.env`.

### Sobre os ids da URL

Em `app.clickup.com/9013302815/v/l/8ckr5gz-2173`:

| Parte | O que é |
| --- | --- |
| `9013302815` | id do workspace — é o `CLICKUP_TEAM_ID` |
| `8ckr5gz-2173` | id da **view** (a visualização em lista), não da lista |

`GET /list/8ckr5gz-2173` devolve 404, porque view e lista são objetos
diferentes. Mas dá para chegar na lista a partir dela: **`CLICKUP_LIST_IDS`
aceita o id da view e o app resolve sozinho**, consultando `GET /view/{id}` e
seguindo para o `parent`. Ou seja, você pode colar o id direto do link do
navegador. Se o pai não for uma lista (uma view de pasta, por exemplo), o app
diz isso explicitamente em vez de falhar sem explicação.

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

### Conferir as premissas da API

```bash
npm run diagnostico -- --estrutura
```

Imprime, campo a campo, se a API real tem o formato que o exportador assume —
só nomes de campos e tipos, **nenhum valor**:

```
    ok  tarefa      status.status         string
    ok  opção       name                  string
    !!  opção       label                 AUSENTE
        valor na tarefa: string (esperado: string com o id da opção)
```

Isto existe por um motivo específico: os testes automatizados rodam contra um
ClickUp falso, escrito junto com o app. Eles provam que o app é **coerente**,
não que a leitura da API v2 está **certa** — se uma premissa sobre um nome de
campo estiver errada, o falso repete o mesmo erro e o teste passa mesmo assim.
Um `!!` em algo que o exportador usa é o aviso de que aquela coluna vai sair
errada.

Existe também a flag `--sem-mascara`, que imprime os valores reais. É só para
conferir localmente — o resultado **não** deve ser compartilhado.

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
