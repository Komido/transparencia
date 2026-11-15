# Arrecadômetro Brasil

Portal de dados públicos sobre a situação do país: arrecadação federal, salário mínimo, dólar e tabela do Imposto de Renda, com a mesma régua para todos os governos e partidos. Estados e cidades são as próximas etapas.

Toda a regra de cálculo está descrita em `site/metodologia.html` e implementada em `site/js/calculos.js`.

## Como funciona

```
Fontes oficiais (Banco Central, IBGE, Receita Federal, DIEESE, BLS)
        │  coleta diária às 06:41 (Brasília), dentro do banco
        ▼
Supabase (Postgres)
  ref     referências: fontes, séries, mandatos, tabela do IR
  dados   observações validadas
  etl     coleta (pg_net + pg_cron), validação e auditoria de cada carga
  painel  JSON publicado e histórico de versões
        │  public.painel(): única leitura pública
        ▼
GitHub Actions (diário, 08:23 em Brasília)
  grava site/dados/painel.json quando os dados mudam
        │  push
        ▼
Cloudflare Pages (site estático)
  o visitante só baixa arquivos estáticos; nunca acessa o Supabase
```

### Garantias da coleta

- Cada fonte é validada antes de gravar: formato, quantidade de registros, cabeçalho do CSV da Receita, datas repetidas. Se algo não bater, a carga é recusada e os dados anteriores continuam valendo.
- Nada é apagado: só inserido ou atualizado. Cada carga registra URL, data, status HTTP, tamanho e hash SHA-256 do arquivo recebido.
- Erros nas próprias fontes (por exemplo, um mês repetido no arquivo da Receita) são detectados e publicados como avisos, sem alterar o dado.

## Estrutura

```
supabase/migrations/   esquema, coleta, validação e painel (na ordem em que foram aplicados)
site/                  site estático publicado na Cloudflare
  index.html           painel
  metodologia.html     regras de cálculo
  js/calculos.js       todas as contas, as mesmas para todos
  js/graficos.js       gráficos SVG sem bibliotecas externas
  dados/painel.json    dados atualizados pelo GitHub Actions
  _headers             cabeçalhos de segurança (CSP, HSTS etc.)
.github/workflows/     atualização diária dos dados
```

## Publicar na Cloudflare (gratuito)

Dá para fazer tudo pelo navegador do celular. Os nomes dos menus podem mudar um pouco.

1. Crie uma conta gratuita em https://dash.cloudflare.com.
2. Abra **Workers & Pages** e escolha **Create**. Na aba **Pages**, escolha **Import an existing Git repository** (ou **Connect to Git**).
3. Autorize a Cloudflare no GitHub e selecione o repositório `Komido/transparencia`.
4. Configure:
   - **Project name:** `arrecadometro-brasil` (vira o endereço `arrecadometro-brasil.pages.dev`, se estiver livre)
   - **Production branch:** `claude/tender-hopper-dbp169` (ou `main`, se ela for criada depois)
   - **Framework preset:** None
   - **Build command:** deixe vazio
   - **Build output directory:** `site`
5. Clique em **Save and Deploy**.

Depois disso, cada atualização de dados feita pelo GitHub Actions publica o site de novo automaticamente.

## Rodar localmente

```
python3 -m http.server 8000 --directory site
```

Abra http://localhost:8000. Os cabeçalhos de segurança de `site/_headers` só são aplicados pela Cloudflare.

## Segurança

- O site não usa cookies, login, rastreamento nem recursos de terceiros. A CSP só permite arquivos do próprio domínio.
- O navegador nunca acessa o Supabase. A chave pública usada pelo GitHub Actions só consegue chamar `public.painel()`; os papéis `anon` e `authenticated` não têm acesso a nenhum esquema de dados, coleta ou auditoria (testado).
- Todo texto vindo dos dados entra na página com `textContent`, e links só são aceitos se forem `https`.

### Ajustes pendentes (precisam de confirmação no painel do Supabase)

- Desativar novos cadastros em Authentication, já que o projeto não usa login.
- Revogar dos papéis `anon` e `authenticated` o acesso ao esquema `net` do pg_net. Ele não está exposto pela API, mas a revogação fecha a porta de vez.
- Remover as funções antigas `etl.*_v1`, que ficaram renomeadas e sem uso para evitar comandos destrutivos durante a construção.

## Limitações conhecidas

Listadas em `site/metodologia.html#limitacoes`. As principais: a arrecadação por tributo começa em 2000; dezembro de 2025 tem um erro no arquivo da Receita (sinalizado no site); a isenção do IR de 1996 a 2000 ainda não foi conferida no texto da Lei 9.250/1995.
