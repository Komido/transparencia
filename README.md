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
  index.html           página inicial: busca da cidade, seu estado, Brasil, Congresso
  cidade.html          página de cada cidade (/cidade/nome-uf), com js/cidade.js
  parlamentar.html     página de cada deputado e senador, com js/parlamentar.js
  metodologia.html     regras de cálculo
  js/calculos.js       todas as contas, as mesmas para todos
  js/graficos.js       gráficos SVG sem bibliotecas externas
  dados/painel.json    dados atualizados pelo GitHub Actions
  _headers             cabeçalhos de segurança (CSP, HSTS etc.)
.github/workflows/     atualização diária dos dados
```

## Publicação na Cloudflare (gratuito)

O site é publicado como Worker com arquivos estáticos, configurado em `wrangler.jsonc`. O único código no servidor é `worker/index.js`, e os arquivos do site não passam por ele. Ele responde só nestes endereços: `/api/onde` (a cidade e o estado prováveis de quem acessa, pelo que a Cloudflare já informa do endereço IP em `request.cf`, sem guardar nada), `/cidade/nome-uf` (a página própria de cada uma das 5.570 cidades, `site/cidade.html` com `site/js/cidade.js`, com título, descrição, manchete e endereço canônico da cidade, para buscadores e compartilhamento; os números são montados no navegador), `/parlamentar/nome-uf` (a página própria de cada deputado e senador, `site/parlamentar.html`, com nome e resumo das emendas no título e na descrição), `/sitemap.xml` e `/robots.txt`. No plano gratuito são até 100 mil execuções por dia; acima disso, só esses endereços param até a meia-noite (UTC). Para testar localmente: `npx wrangler dev`. O Worker `arrecadometro-brasil` está ligado a este repositório pelo Workers Builds: cada push na branch de produção, inclusive os commits diários de dados do GitHub Actions, publica o site de novo.

Para recriar do zero:

1. No painel da Cloudflare, abra **Workers & Pages** → **Create application** e importe o repositório pelo GitHub, dando acesso só a ele.
2. Nome do projeto: `arrecadometro-brasil` (o mesmo do `wrangler.jsonc`).
3. Comando da build: vazio. Comando de implantação: `npx wrangler deploy`.
4. Deixe **Proteger com Cloudflare Access** desligado, senão o site exige login.

Para conferir a configuração sem publicar: `npx wrangler deploy --dry-run`.

## Rodar localmente

```
python3 -m http.server 8000 --directory site
```

Abra http://localhost:8000. Os cabeçalhos de segurança de `site/_headers` só são aplicados pela Cloudflare.

## Segurança

- O site não usa cookies, login, rastreamento nem recursos de terceiros. A CSP só permite arquivos do próprio domínio.
- A sugestão de cidade usa a estimativa de local que a Cloudflare faz do endereço IP de cada acesso; o Worker devolve só país, estado e cidade e não registra nada. A cidade escolhida fica guardada só no navegador do visitante (`localStorage`).
- O navegador nunca acessa o Supabase. A chave pública que aparece no workflow é pública por definição: ela só consegue chamar `public.painel()`. Os papéis `anon` e `authenticated` não têm acesso a nenhum esquema de dados, coleta ou auditoria (testado).
- Cadastros de usuário estão bloqueados por um gatilho em `auth.users`, porque o projeto não tem login. Testado pela API pública: a tentativa é recusada e o banco continua sem usuários.
- Todo texto vindo dos dados entra na página com `textContent`, e links só são aceitos se forem `https`.
- O repositório não contém senhas, tokens nem dados pessoais (varredura no histórico completo).

### Pontos conhecidos

- O esquema `net` (pg_net) é acessível aos papéis `anon` e `authenticated` por padrão da plataforma, e essas concessões pertencem ao papel interno `supabase_admin`, que o projeto não controla. Ele não está exposto pela API; não adicione `net` aos esquemas expostos nas configurações.
- As funções antigas `etl.*_v1` ficaram renomeadas e sem uso para evitar comandos destrutivos durante a construção. Podem ser removidas numa limpeza pelo painel do Supabase.

### Como apontar um erro

Abra uma issue descrevendo o número, a fonte oficial e o período. Para falhas de segurança, use a opção de relato privado na aba Security do repositório, em vez de uma issue pública.

## Licenças

- Código: MIT ([LICENSE](LICENSE)).
- Textos do site e documentação: CC BY 4.0.
- Dados: pertencem às fontes oficiais, sempre citadas.

Detalhes em [LICENCA-CONTEUDO.md](LICENCA-CONTEUDO.md).

## Limitações conhecidas

Listadas em `site/metodologia.html#limitacoes`. As principais: a arrecadação por tributo começa em 2000; dezembro de 2025 tem um erro no arquivo da Receita (sinalizado no site); a isenção do IR de 1996 a 2000 ainda não foi conferida no texto da Lei 9.250/1995.
