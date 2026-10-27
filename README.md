# Painel Virtual – Executivos QuintoAndar

Protótipo navegável do painel RTx para acompanhamento diário dos processos dos clientes.

## Como abrir com dados reais do Pipefy

No terminal do VS Code, execute:

```powershell
node server.mjs
```

Ou execute a tarefa **Iniciar Painel RTx** pelo menu `Terminal > Executar Tarefa` do VS Code. No Windows, também é possível abrir o arquivo `Iniciar Painel RTx.cmd` com dois cliques.

Depois abra `http://127.0.0.1:4173`. O servidor local mantém as credenciais fora do navegador, renova o token OAuth automaticamente e atualiza o cache do Pipefy a cada cinco minutos.

Abrir `index.html` diretamente continua funcionando, mas exibe somente dados demonstrativos.

## Acesso

O acesso do gestor é validado pelo servidor com suas credenciais exclusivas. Os executivos entram com o e-mail cadastrado no campo `E-mail Executivo` do DB_Executivos e com a senha-padrão definida no servidor. Somente o sal e o hash das senhas ficam em `.env`/`.env.local` e nas variáveis secretas da hospedagem; as senhas e seus hashes não são publicados no repositório nem armazenados no navegador.

O servidor também limita a resposta da API conforme o perfil autenticado: o gestor recebe a carteira completa, enquanto cada executivo recebe somente os clientes vinculados ao seu nome no DB_Executivos.

## Importante sobre segurança

A autenticação local usa senha protegida por `scrypt`, cookie de sessão `HttpOnly`, expiração e limite de tentativas. Antes da publicação externa, ainda é necessário usar HTTPS, armazenamento persistente de sessões e gestão individual de contas.

## Próxima etapa recomendada

Conectar o painel a uma fonte real de dados (por exemplo Pipefy, planilha controlada ou banco de dados) e implementar autenticação no servidor. A marca atual é uma representação tipográfica baseada nas referências fornecidas; o arquivo oficial da logo pode substituir o bloco `.brand-mark` quando estiver disponível.

## Configuração do Pipefy

O arquivo `.env` contém os campos privados da integração e já está ignorado pelo Git. Preencha localmente:

- `PIPEFY_CLIENT_ID`: Client ID da Service Account.
- `PIPEFY_CLIENT_SECRET`: Client secret da Service Account.
- `PIPEFY_OAUTH_TOKEN_URL`: OAuth Token URL fornecida pelo Pipefy.
- `PIPEFY_PIPE_APROVACAO_ID`: ID do pipe do Painel Aprovação.
- `PIPEFY_PIPE_PROCESSOS_ID`: ID do pipe do Painel Processos.
- `PIPEFY_DATABASE_EXECUTIVOS_ID`: opcional; ID de `DB_Executivos`.

Nunca coloque esses valores em `app.js`, `index.html`, commits, capturas de tela ou mensagens.

O servidor usará essas três informações para solicitar automaticamente um token temporário com o fluxo OAuth2 `client_credentials`. O token gerado não deve ser preenchido manualmente no arquivo.

## Publicação

Este projeto precisa de uma hospedagem de aplicação Node, pois o login, as sessões e a conexão protegida com o Pipefy são executados no servidor. GitHub Pages sozinho não executa esse backend.

O arquivo `render.yaml` deixa o repositório pronto para publicação como **Web Service** no Render:

1. Publique o repositório no GitHub sem o arquivo `.env`.
2. No Render, escolha `New > Blueprint` e conecte o repositório.
3. Preencha as variáveis marcadas como secretas usando os valores do `.env` local.
4. Conclua a criação do serviço e use o endereço HTTPS fornecido pelo Render.

O servidor usa automaticamente a porta e o endereço de rede fornecidos pela hospedagem, adiciona cookies seguros em HTTPS e disponibiliza `/api/health` para verificação de saúde.
