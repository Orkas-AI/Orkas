# Orkas

**Uma equipe de agentes de IA de código aberto no seu computador, que transforma seus objetivos em trabalho concluído e mantém tudo em andamento.**

O Orkas é um aplicativo multiagente para desktop, de código aberto (MIT) e local-first: um assistente de IA que trabalha como uma equipe. Diga ao **Commander** do que você precisa: ele conclui muitas tarefas sozinho e, para trabalhos maiores, planeja as etapas e chama agentes especialistas, junto com os agentes de programação e pessoais que você já usa (**Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent**), para trabalharem juntos.

O Orkas foi feito para manter um projeto em andamento, não só para responder a um prompt. Um **projeto** reúne o objetivo, as regras, a memória e os arquivos, para que cada nova conversa continue de onde a anterior parou. A lista **A fazer** divide o trabalho entre pessoas e agentes, o **Avanço automático** deixa a equipe pegar sozinha o próximo item da lista e as **automações agendadas** repetem o trabalho de rotina a cada hora, dia, semana ou mês. Todos os seus dados ficam no seu computador, e o trabalho concluído volta para você revisar; assim, você pode confiar ao Orkas o trabalho contínuo do seu negócio.

**[⬇ Baixe o Orkas para macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — grátis, com 500 créditos para o modelo integrado do Orkas, então você não precisa de uma chave de API para começar. Prefere usar suas próprias chaves? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, ou um endpoint local compatível com OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas no desktop: conversa de uma tarefa e entregáveis](./resources/app-ui/task-en.png)

---

## O que a equipe entrega

- **Vídeos, narrações e imagens** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Relatórios de pesquisa, auditorias de SEO e análises de mercado** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Posts, artigos, newsletters e apresentações de slides** — ContentWriter, PptMaker
- **Sites, interfaces e código** — UIDesigner, ProductDeveloper
- **Arquivos Word, Excel, PowerPoint e PDF** — OfficeWorker
- **Trabalho de e-commerce** — pesquisa de produtos, anúncios, análise de avaliações, análise de vendas e alterações no catálogo, feitos por cinco agentes de e-commerce
- **Trabalhos complexos que exigem vários agentes** — o Commander divide o trabalho, entrega cada parte ao agente certo e junta os resultados; por exemplo, uma pesquisa de mercado que se transforma em um relatório, uma apresentação de slides e um vídeo de lançamento

O aplicativo vem com 16 especialistas, cada um com suas próprias habilidades, memória e ferramentas. Navegue por mais de 30 agentes no [mercado de agentes](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) ou descreva a função de que você precisa, e o Commander cria um agente personalizado para você.

<details>
<summary><b>Todos os 16 agentes integrados</b></summary>

| Área | Agente | O que entrega |
| --- | --- | --- |
| Pesquisa e análise | **DeepResearcher** | Pesquisa baseada em evidências, com fontes verificadas, contradições sinalizadas e um relatório auditável |
| | **SeoGeoAgent** | Informe uma URL: auditoria técnica, qualidade do conteúdo, Core Web Vitals, potencial de citação em respostas de IA (GEO) e lista de correções priorizada |
| | **StockAnalyser** | Análise de ações, filtros por fatores, backtests e verificação de risco da carteira, com dashboards rastreáveis |
| Conteúdo e mídia | **ContentWriter** | Posts, artigos, newsletters e estudos de caso prontos para publicar, a partir de um objetivo, de fontes ou de um rascunho |
| | **PptMaker** | Apresentações PPTX editáveis e fáceis de revisar, a partir de um tema, de um esboço ou de um documento |
| | **ImageStudio** | Pôsteres, capas, imagens para redes sociais e infográficos |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narração, apresentadores de IA, legendas e dublagem, clipes com os melhores momentos, localização e recriação de vídeos de referência com seu próprio conteúdo e suas próprias gravações |
| | **VoiceStudio** | Narração, áudio com várias vozes, transcrições e legendas, edição e mixagem de áudio |
| | **UIDesigner** | Interfaces editáveis baseadas em HTML, a partir de objetivos de produto, PRDs, capturas de tela ou material do Figma |
| Desenvolvimento e escritório | **ProductDeveloper** | Engenharia que conhece o seu repositório: implementa um PRD, corrige bugs, refatora e revisa, com resultados verificáveis |
| | **OfficeWorker** | Cria, edita, verifica e entrega arquivos Word / Excel / PowerPoint / PDF, um de cada vez ou em lote |
| E-commerce | **ECommerceResearcher** | Seleção de produtos por orçamento, mercado e limites de fornecimento: candidatos, motivos de descarte e planos de validação |
| | **ECommerceWriter** | Títulos, páginas de detalhes, perguntas frequentes, textos para imagens e roteiros de vídeo com a voz da sua marca |
| | **ECommerceReviewer** | Análise de avaliações e reputação: temas recorrentes dos clientes, causas-raiz das avaliações negativas e prioridades |
| | **ECommerceAnalyzer** | Vendas, lucro, anúncios, reembolsos e estoque a partir das suas exportações: métricas conciliadas e decisões |
| | **ECommerceOperator** | Planeja mudanças de catálogo, preço, promoção e estoque; executa apenas por meio das ferramentas que você conectar |

Mais sobre cada agente → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Recrie um vídeo de referência com seu próprio conteúdo

**VideoStudio** pode recriar a estrutura narrativa, o estilo visual e o ritmo de edição de um vídeo viral usando seu próprio produto, roteiro e gravações. Envie um arquivo de vídeo de referência e seus materiais: o agente analisa o gancho, a ordem das informações, os momentos visuais marcantes e a chamada para ação e, antes da produção, propõe o que manter e o que substituir.

Funciona melhor com vídeos explicativos em motion graphics, demos de SaaS ou de aplicativos e anúncios de produto feitos com as gravações que você já tem. Textos, legendas, narrações e clipes criados localmente podem ser revisados separadamente; para mudar um texto embutido em cenas geradas por IA, é preciso alterar essas cenas.

> "Use o reference.mp4 como referência para um vídeo promocional vertical de 30 segundos. Mantenha o gancho, a tipografia e o ritmo dele, troque o conteúdo pelo meu produto e pelas minhas gravações de tela, e me mostre primeiro o detalhamento e o plano."

Comece com um arquivo de vídeo que o agente consiga ler; o download a partir de links de compartilhamento de redes sociais não está incluído. Movimentos de câmera exatos, atuações humanas e correspondência quadro a quadro não são garantidos. Veja o [fluxo de recriação a partir de referência](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Mantenha o trabalho em andamento

Uma tarefa é um bom começo. O Orkas foi feito para o trabalho que continua.

- **Projetos** — objetivos e regras, memória e arquivos que servem de ponto de partida para toda conversa do projeto, para que você nunca precise explicar tudo do zero.
- **A fazer e Avanço automático** — todo projeto tem uma lista de tarefas a fazer para pessoas e agentes; com o Avanço automático ligado, a equipe pega sozinha o próximo item e devolve o trabalho concluído para você revisar.
- **Automações agendadas** — execute qualquer tarefa a cada hora, dia, semana ou mês. O Orkas roda no seu computador. A partir da v1.9, quando o computador sai do modo de suspensão ou o Orkas é iniciado, cada automação recupera a execução perdida mais recente das últimas 12 horas.
- **Conectores** — Gmail, Google Calendar, Sheets e Drive, Notion, Slack, Shopify, Stripe e muitos outros. Por padrão, o Orkas pede confirmação antes de enviar, publicar ou excluir qualquer coisa.
- **Aplicativos** — descreva uma ferramenta e o Orkas a cria como um aplicativo local dentro do app para desktop. No aplicativo instalável, os planos pagos também podem publicá-la como aplicativo web com um link público.
- **Projetos compartilhados** *(aplicativo instalável)* — convide um colega de equipe ou um assistente virtual e atribua cada tarefa a uma pessoa ou a um agente.

> [!NOTE]
> Projetos compartilhados, sincronização na nuvem e publicação de aplicativos web só estão disponíveis no aplicativo instalável; a versão de código aberto ainda não oferece esses recursos. Para usá-los, **[baixe o Orkas para macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (grátis, com 500 créditos para começar).

A entrada por voz também funciona na versão do código-fonte. Configure uma **Orkas API Key** em **Configurações → Modelos** e clique no microfone ao lado da caixa de mensagem. Permita o acesso ao microfone quando for solicitado. O áudio é enviado ao Orkas para reconhecimento e consome os créditos do Orkas do dono da chave. Clique de novo para parar, revise o texto e envie você mesmo. Se você negou o acesso, ative o microfone nas configurações do sistema.

---

## Execute Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent juntos

O Orkas executa como sessões locais os agentes de CLI que você já tem instalados, ao lado dos próprios especialistas: os agentes de programação **Claude Code, Codex e OpenCode** e os agentes pessoais **OpenClaw e Hermes-Agent**. O Commander entrega a cada um a parte em que ele é melhor e mantém um único plano para todos, de modo que um só chat pode corrigir o bug, revisar a alteração e redigir a nota de versão. Ferramentas de código aberto como o HyperFrames se conectam da mesma forma.

[Como usar Claude Code e Codex juntos →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Por que o Orkas

- **Um Commander que planeja, delega e faz o resto** — ele divide os objetivos, escolhe os agentes, as habilidades, os conectores e as ferramentas certos, e ele mesmo cuida da análise, da redação, da pesquisa e do trabalho com arquivos quando nenhum especialista é mais adequado.
- **Local-first desde a concepção** — conversas, arquivos, bases de conhecimento e agentes personalizados ficam no seu disco por padrão. A sincronização na nuvem é opcional no aplicativo instalável. Com suas próprias chaves, as chamadas aos modelos vão direto da sua máquina para o provedor; o modelo integrado do Orkas funciona pelo serviço de modelos gerenciado pelo Orkas.
- **Qualquer modelo, troque quando quiser** — o Commander e os agentes integrados compartilham uma mesma configuração de modelo: o modelo integrado do Orkas, seu próprio provedor ou um endpoint local. Agentes de CLI externos mantêm as próprias configurações de modelo.
- **Agentes que evoluem** — cada agente mantém habilidades e memória privadas. Revisões em segundo plano examinam a atividade nova quando o aplicativo está ocioso e podem refinar a autoavaliação, os métodos reutilizáveis e as habilidades aprendidas.
- **Código aberto, sem caixa-preta** — licença MIT. Veja exatamente o que o Orkas, cada agente e cada habilidade fazem.

> ⭐ Se o Orkas for útil para você, uma estrela ajuda mais pessoas a encontrar o projeto.

---

## Baixar

| | Aplicativo instalável (recomendado) | Executar a partir do código-fonte |
| --- | --- | --- |
| Plataformas | macOS 12+ (Apple Silicon e Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 com glibc 2.34+ |
| Conta | Fazer login — 500 créditos grátis | Nenhuma |
| Modelos | Modelo integrado do Orkas ou suas próprias chaves | Suas próprias chaves ou um endpoint local |
| Também inclui | Colaboração em projetos, publicação de aplicativos, sincronização na nuvem e mais | — |
| Como obter | **[Baixar o Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Início rápido](#início-rápido) |

O link de download detecta seu sistema e inicia o instalador certo.

---

## Para que as pessoas usam

- **Conteúdo de marketing** — vídeos de lançamento, páginas de produto, posts e newsletters com a sua voz. [Criação de conteúdo](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Vídeos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Operação de lojas** — resumos semanais de vendas, respostas a avaliações, anúncios e acompanhamento da concorrência. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Pesquisas e relatórios** — relatórios e apresentações com fontes, sob demanda ou toda semana. [Pesquisa](https://orkas.ai/use/researchers/?source=gh-orkas) · [Análise de dados](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Converse com seus documentos** — respostas baseadas nos seus próprios arquivos, com citações que remetem aos trechos de origem. [Chat com documentos](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Trabalho para clientes** — resumos para reuniões, relatórios mensais para clientes e apresentações de atualização no seu modelo. [Modelo de relatório mensal para clientes](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lançamento de produto** — landing pages, correções de bugs com testes, registros de mudanças e posts de lançamento. [Desenvolvedores](https://orkas.ai/use/developers/?source=gh-orkas)
- **Crie um aplicativo** — calculadoras de orçamento, formulários de agendamento, ferramentas internas. [Criar aplicativos](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Equipes pequenas** — um só projeto para pessoas e agentes. [Equipes pequenas](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Como o Orkas se compara

| Ferramenta | O que é | Como o Orkas se diferencia |
| --- | --- | --- |
| **Claude Code** | Ferramenta de programação agêntica da Anthropic — no terminal, no IDE, no desktop e na web, baseada nos modelos Claude. | Não é preciso escolher: o Orkas executa o Claude Code como um dos seus agentes. Em volta dele, o Orkas adiciona uma equipe que funciona com qualquer modelo para o trabalho além do código (pesquisa, conteúdo, vídeo e mais), com projetos, tarefas a fazer e automações que mantêm tudo em andamento. [Orkas vs. Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | O agente de programação da OpenAI — no terminal, no seu editor e na nuvem. | Não é preciso escolher: o Orkas executa o Codex como um dos seus agentes, ao lado do Claude Code e do OpenCode. O Commander pode passar a programação para o Codex e a revisão para outro agente e, depois, cuidar da metade do lançamento que não é código: documentação, posts de lançamento e vídeos. [Orkas vs. Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | O agente da Anthropic para o trabalho do dia a dia, agora parte do Claude — no desktop, na web e no celular, com um plano pago do Claude. Por padrão, roda na nuvem da Anthropic e usa modelos Claude. | Uma alternativa de código aberto (MIT) ao Claude Cowork, que você pode começar a usar de graça, com 500 créditos. O Orkas executa os próprios agentes no seu computador e, por padrão, mantém seus dados localmente, com o modelo integrado do Orkas, chaves do seu próprio provedor ou um endpoint local. O Commander também pode chamar o Claude Code, o Codex e outros agentes de CLI. A contrapartida: o Orkas precisa do seu computador ligado e ativo, enquanto as tarefas na nuvem do Cowork podem continuar rodando sem ele. [Alternativas ao Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Um agente de IA que, por padrão, planeja e executa tarefas na nuvem do Manus. O app para desktop Manus Studio (macOS e Windows) também pode trabalhar em uma pasta escolhida por você, com as tarefas ainda planejadas na nuvem. | Uma alternativa de código aberto (MIT) ao Manus. O Orkas executa os próprios agentes no seu computador e, por padrão, mantém seus dados localmente, com o modelo integrado do Orkas, chaves do seu próprio provedor ou um endpoint local. Projetos, tarefas a fazer e automações mantêm o trabalho em andamento. A contrapartida: o Orkas precisa do seu computador ligado e ativo, enquanto as tarefas na nuvem do Manus podem continuar rodando sem ele. [Alternativa de código aberto ao Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Um framework/biblioteca para desenvolvedores criarem aplicativos e agentes com LLM — focado em código, incorporado ao seu próprio aplicativo em Python/JS. | O Orkas é um aplicativo para desktop que você comanda pelo chat, sem escrever código de orquestração. Por padrão, os dados ficam armazenados localmente. |
| **CrewAI** | Um framework em Python para orquestrar agentes autônomos que assumem papéis — você define equipes (crews) e agentes em código. | O Orkas leva a orquestração multiagente para um aplicativo para desktop, com projetos, tarefas a fazer, automações e automelhoria por agente já integrados. |
| **OpenClaw** | Uma plataforma de agentes pessoais com integrações de mensagens, roteamento multiagente e subagentes. | O Orkas oferece um espaço de trabalho no desktop para entregas finalizadas, com especialistas integrados e coordenação entre Claude Code, Codex, OpenCode e outros agentes de CLI. O OpenClaw pode entrar nesse fluxo de trabalho como agente de CLI. |
| **Hermes-Agent** | O agente autoaperfeiçoável da Nous Research — um único agente com memória e habilidades, disponível como CLI, gateway de mensagens e aplicativo para desktop. | O Orkas coordena uma equipe: o Commander dirige vários especialistas e outros agentes de CLI, e o Hermes-Agent entra como um deles. |

**O Orkas é para você se** busca uma equipe de agentes em vez de um único assistente, um trabalho que continue avançando ao longo dos dias, e seus dados, chaves e agentes no seu próprio disco.

**Não é para você se** só quer um único chatbot para tudo ou uma biblioteca de código pura para incorporar ao seu próprio aplicativo.

**Está escolhendo entre agentes de programação?** [Codex vs. OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs. Codex vs. OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternativas ao Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Comparações completas lado a lado →** [vs. Claude Code](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) · [vs. Codex](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) · [vs. Cline](https://orkas.ai/compare/orkas-vs-cline/?source=gh-orkas) · [vs. LangChain](https://orkas.ai/compare/orkas-vs-langchain/?source=gh-orkas) · [vs. ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt/?source=gh-orkas) · [vs. OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw/?source=gh-orkas) · [vs. Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent/?source=gh-orkas)

---

## Início rápido

Prefere um instalador pronto? Veja [Baixar](#baixar) acima. Para executar a partir do código-fonte, que hoje é a forma de rodar o Orkas no Linux:

**Requisitos**: Node 22.12+ · macOS / Windows 10+ / Linux x64 ou arm64 com glibc 2.34+. Mantenha Python 3 e um toolchain de compilação C/C++ disponíveis para o caso incomum de ser preciso compilar os módulos nativos a partir do código-fonte.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

No Linux, a execução a partir do código-fonte exige glibc 2.34+. Alpine e outras distribuições baseadas em musl não são suportadas. A transcrição de fala local baixa e verifica o ambiente de execução nativo do whisper.cpp para a plataforma de destino e o modelo multilíngue durante a primeira inicialização a partir do código-fonte.

`run.sh` / `run.cmd` instala a árvore de dependências npm com versões travadas e, na primeira inicialização, prepara as versões fixadas do Python, uv, Node, modelo de embeddings (~95 MB), OfficeCLI, FFmpeg, whisper.cpp e os recursos do modelo de fala multilíngue. Em seguida, a inicialização no Linux verifica os módulos nativos da plataforma e o ambiente de execução do Whisper sob a ABI do Electron antes de abrir o aplicativo. Os pacotes Python de OCR e os específicos de cada habilidade são instalados em ambientes locais isolados na primeira vez em que esses recursos são usados. A primeira inicialização cria um espaço de trabalho em `~/.orkas/` (macOS / Linux) ou `<smallest non-system drive>:\.orkas\` (Windows). Depois, abra **Configurações → Provedores de IA** para adicionar uma chave de API ou OAuth.

Erros de dependências nativas: use o Node.js 24 LTS (mínimo 22.12.0) e depois execute
`npm run native:repair` nesta cópia do repositório. Isso restaura os pacotes opcionais,
repara o SQLite para o Electron, prepara o Node incluído para o processamento isolado de imagens
e verifica SQL, sqlite-vec e sharp antes de indicar sucesso.
Use `npm run native:check` para fazer uma verificação sem instalar nada.
Veja o [script de verificação de dependências nativas](./scripts/verify-native-dependencies.cjs) para conferir as verificações realizadas.

---

## Como funciona

### Roteamento de tarefas

O Commander cuida ele mesmo do trabalho geral e delega o trabalho especializado por meio de três ferramentas:

- **`dispatch_to`** executa um agente com nome e retorna o resultado dele para a continuação do trabalho. Pode aguardar o resultado ou rodar de forma assíncrona e notificar o Commander quando a tarefa terminar.
- **`hand_off_to`** transfere o trabalho restante para um agente com nome e encerra o turno atual do Commander. O agente entrega a própria resposta; uma continuação opcional permite que o Commander retome depois uma tarefa mais ampla.
- **`run_worker`** executa uma subtarefa anônima e isolada e retorna um resultado privado. Ela não recebe o histórico da conversa nem as habilidades de um agente com nome.

Tarefas de agentes com nome e workers anônimos têm controles de concorrência separados. Veja a [implementação do despacho](./src/main/features/group_chat/bus.ts) e os [bloqueios de execução](./src/main/util/locks.ts).

### Gerenciamento de contexto

O ambiente de execução calcula o orçamento de contexto com base na capacidade de entrada utilizável do modelo selecionado, considerando prompts, ferramentas e o estado persistente do ambiente de execução. Diálogos concluídos usam uma janela limitada de histórico recente; tarefas ativas longas usam pontos de controle para condensar mensagens anteriores do processo, mantendo o trabalho recente. Leituras de arquivos, alterações em arquivos e execuções de comandos também têm registros estruturados que podem sobreviver à compactação do contexto.

Veja [orçamentos de contexto](./src/core-agent/src/agent/context-budget.ts), [histórico de sessão e pontos de controle](./src/core-agent/src/agent/session.ts) e [registros do espaço de trabalho](./src/core-agent/src/agent/workspace-state.ts).

### Memória e a Biblioteca

Notas persistentes guardam as preferências do usuário, os fatos do projeto e o conhecimento reutilizável de cada agente em escopos separados. Essas notas são diferentes do índice de documentos da Biblioteca e do histórico de conversas armazenado.

A Biblioteca divide os documentos em trechos e armazena um índice vetorial local em SQLite. O modelo de embeddings dela roda na sua máquina; a ferramenta `library` pode listar arquivos, buscar trechos relevantes e ler o conteúdo original da Biblioteca global ou da Biblioteca do projeto atual. Conversas anteriores são recuperadas separadamente por meio de `chat_history`.

Veja [memória com escopo](./src/main/features/memory.ts), [extração de documentos](./src/main/util/file_to_chunks.ts), [ferramentas da Biblioteca](./src/main/model/core-agent/kb-tools.ts) e [recuperação de conversas](./src/main/model/core-agent/chat-history-tools.ts).

### Limites de execução e recuperação

Bloqueios de sessão e limites de concorrência restringem o trabalho em paralelo. Orçamentos de rodadas de ferramentas, pontos de controle de progresso, verificações de chamadas repetidas e watchdogs de ociosidade sensíveis à fase ajudam a conter execuções que travam ou repetem trabalho. Tarefas de agentes com nome podem ser acompanhadas e canceladas individualmente; uma tarefa aceita ou na fila não é tratada como resultado concluído.

Veja [orçamentos de atores](./src/main/features/group_chat/actor-budgets.ts), o [ambiente de execução dos agentes](./src/core-agent/src/agent/runner.ts) e o [adaptador de modelos do aplicativo para desktop](./src/main/model/core-agent/client.ts).

### Aprendizado com a atividade

Revisões em segundo plano examinam a nova atividade dos agentes quando o aplicativo está ocioso, sujeitas a períodos de espera e limites de execução. Uma revisão pode atualizar a autoavaliação de um agente (`COMPETENCE.md`), os métodos reutilizáveis (`LEARNING_STRATEGIES.md`) ou as habilidades aprendidas. As revisões dependem de atividade nova, e não do número de tarefas, e podem concluir que não há nada que valha a pena salvar.

Veja o [agendador de reflexão](./src/main/features/reflection-orchestrator.ts) e o [prompt de revisão](./src/core-agent/src/evolution/metacognition.ts).

---

## Perguntas frequentes

**O que é o Orkas?**
O Orkas é um aplicativo multiagente para desktop, de código aberto (MIT) e local-first. O Commander do Orkas transforma seu objetivo em tarefas a fazer e coordena 16 agentes especialistas integrados — além de Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent — para entregar arquivos prontos. Não é um único chatbot, nem um framework de código, nem um SaaS hospedado.

**Preciso de uma chave de API?**
Não. O aplicativo instalável vem com 500 créditos para o modelo integrado do Orkas. Depois disso, compre créditos, escolha um plano pago ou adicione as chaves do seu próprio provedor; as cobranças do provedor são à parte.

**O Orkas é um LLM local?**
Não. O Orkas roda na sua máquina e chama os modelos que você escolher: o modelo integrado do Orkas, suas próprias chaves de API ou um endpoint de modelo local. Ele orquestra agentes e ferramentas; não é, ele próprio, um modelo.

**O Orkas consegue responder a perguntas com base nos meus documentos, com citações?**
Sim. Adicione PDFs e outros documentos à sua Biblioteca local; o Orkas pode pesquisar neles e responder com citações dos trechos de origem, para que você possa abrir o original e conferir. O índice é criado na sua máquina.

**Posso usar modelos locais como Ollama ou LM Studio?**
Sim. Abra **Configurações da conta → Modelos → Chat → Adicionar modelo → Personalizado**, selecione **Compatível com OpenAI** ou **Compatível com Anthropic** e informe a URL base, o ID exato do modelo e a chave de API. Escolha o modelo salvo no seletor de modelo da tarefa.

**Onde ficam minhas chaves de API e meus dados?**
No seu disco, por padrão. As chaves do seu próprio provedor são criptografadas localmente e ficam fora da sincronização na nuvem. Com suas próprias chaves, as chamadas aos modelos vão direto da sua máquina para o provedor; o modelo integrado do Orkas usa o serviço gerenciado do Orkas. A sincronização na nuvem opcional e os projetos compartilhados do aplicativo instalável armazenam os dados selecionados nos servidores do Orkas. [Segurança e tratamento de dados →](https://orkas.ai/security/?source=gh-orkas)

**O Orkas funciona offline?**
A versão do código-fonte pode funcionar totalmente offline com um endpoint de modelo local. O aplicativo instalável precisa de login, e os modelos na nuvem precisam de conexão de rede.

**Ele continua funcionando quando meu computador está desligado?**
Não — o Orkas roda no seu computador, então o Avanço automático e as automações precisam do computador ligado e ativo e do Orkas em execução. A partir da v1.9, quando o computador sai do modo de suspensão ou o Orkas é iniciado, cada automação recupera a execução perdida mais recente das últimas 12 horas.

**Posso criar e publicar aplicativos?**
Sim. Aplicativos locais que rodam dentro do Orkas são gratuitos. Publicar um aplicativo web com link público exige um plano pago (Lite 5, Pro 8, Max 15 aplicativos), e os aplicativos web publicados não incluem todos os recursos disponíveis dentro do Orkas.

**Preciso de uma conta do Orkas?**
O aplicativo para desktop instalável pede que você faça login na primeira vez que o abrir. A versão do código-fonte neste repositório não tem nenhuma camada de contas: ela abre direto no aplicativo.

**O Orkas consegue controlar o Claude Code e outros agentes de CLI?**
Sim. O Orkas pode controlar cinco agentes de CLI externos como subprocessos locais — os agentes de programação Claude Code, Codex e OpenCode, além dos agentes pessoais OpenClaw e Hermes-Agent — e incorporar projetos de código aberto como o HyperFrames, tudo comandado do mesmo chat.

**Qual é a diferença entre o Orkas e o Claude Code / Codex / CrewAI / LangChain?**
Claude Code e Codex são agentes de programação, e o Orkas executa os dois como membros da própria equipe, então você não precisa escolher entre eles; CrewAI e LangChain são frameworks focados em código. O Orkas é um aplicativo para desktop de código aberto em que um Commander coordena uma equipe de agentes especialistas e os seus agentes de CLI, com qualquer provedor de modelos, e mantém dados e chaves localmente. Veja as [comparações completas](https://orkas.ai/compare/?source=gh-orkas).

**Quais plataformas o Orkas suporta?**
macOS 12+ (Apple Silicon e Intel) e Windows 10+ têm instaladores. Linux x64/arm64 com glibc 2.34+ roda hoje a partir do código-fonte, ainda sem instalador. A transcrição de fala local é suportada no Linux por meio do ambiente de execução fixado do whisper.cpp, preparado na primeira inicialização. Alpine e outras distribuições baseadas em musl não são suportadas. A inicialização a partir do código-fonte exige Node 22.12+; Python 3 e um toolchain de compilação C/C++ só são necessários quando um pacote npm nativo não tem um binário pré-compilado compatível e precisa ser recompilado localmente.

**O Orkas é gratuito e de código aberto?**
Sim — o aplicativo tem licença MIT e é gratuito. O aplicativo instalável inclui 500 créditos para o modelo integrado do Orkas; planos pagos a partir de $11.99/mês adicionam créditos mensais, sincronização na nuvem, mais projetos compartilhados e publicação de aplicativos. Com suas próprias chaves, o uso dos modelos é cobrado pelo seu provedor; o Orkas não cobra nenhuma margem adicional. [Preços →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licença

[MIT](./LICENSE)
