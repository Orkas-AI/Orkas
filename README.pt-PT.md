# Orkas

**Uma equipa de agentes de IA de código aberto no seu computador, que transforma os seus objetivos em trabalho concluído e o mantém a avançar.**

O Orkas é uma aplicação multiagente para computador, de código aberto (MIT), que dá prioridade ao funcionamento local: um assistente de IA que trabalha como uma equipa. Diga ao **Commander** aquilo de que precisa: conclui muitas tarefas sozinho e, para trabalhos maiores, planeia os passos e chama agentes especialistas, juntamente com os agentes de programação e pessoais que já utiliza (**Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent**), para trabalharem em conjunto.

O Orkas foi concebido para manter um projeto a avançar, e não apenas para responder a um pedido. Um **projeto** reúne o objetivo, as regras, a memória e os ficheiros, para que cada nova conversa retome o trabalho onde a anterior o deixou. A lista **A fazer** divide o trabalho entre pessoas e agentes, o **Avanço automático** permite que a equipa assuma por si só a tarefa seguinte e as **automações agendadas** repetem o trabalho de rotina de hora a hora, diariamente, semanalmente ou mensalmente. Todos os seus dados ficam no seu computador e o trabalho concluído regressa às suas mãos para revisão; assim, pode confiar ao Orkas o trabalho contínuo do seu negócio.

**[⬇ Transferir o Orkas para macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — gratuito, com 500 créditos para o modelo integrado do Orkas, pelo que não precisa de uma chave de API para começar. Prefere utilizar as suas próprias chaves? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, ou um endpoint local compatível com OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Orkas para computador: conversa de uma tarefa e resultados entregues](./resources/app-ui/task-en.png)

---

## O que a equipa entrega

- **Vídeos, locuções e imagens** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Relatórios de investigação, auditorias de SEO e análises de mercado** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Publicações, artigos, newsletters e apresentações de diapositivos** — ContentWriter, PptMaker
- **Websites, interfaces e código** — UIDesigner, ProductDeveloper
- **Ficheiros Word, Excel, PowerPoint e PDF** — OfficeWorker
- **Comércio eletrónico** — estudo de produtos, fichas de produto, análise de avaliações, análise de vendas e alterações ao catálogo, a cargo de cinco agentes de comércio eletrónico
- **Trabalho complexo que exige vários agentes** — o Commander divide-o, entrega cada parte ao agente certo e junta os resultados; por exemplo, um estudo de mercado que dá origem a um relatório, a uma apresentação de diapositivos e a um vídeo de lançamento

A aplicação inclui 16 especialistas, cada um com as suas próprias competências, memória e ferramentas. Explore mais de 30 agentes no [catálogo de agentes](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) ou descreva a função de que precisa e o Commander cria um agente personalizado para si.

<details>
<summary><b>Os 16 agentes integrados</b></summary>

| Área | Agente | O que entrega |
| --- | --- | --- |
| Investigação e análise | **DeepResearcher** | Investigação baseada em evidências, com fontes verificadas, contradições assinaladas e um relatório auditável |
| | **SeoGeoAgent** | Indique um URL: auditoria técnica, qualidade do conteúdo, Core Web Vitals, potencial de citação em respostas de IA (GEO) e lista de correções por ordem de prioridade |
| | **StockAnalyser** | Análise de ações, filtragem por fatores, backtests e verificação do risco da carteira, com painéis rastreáveis |
| Conteúdo e multimédia | **ContentWriter** | Publicações, artigos, newsletters e estudos de caso prontos a publicar, a partir de um objetivo, de fontes ou de um rascunho |
| | **PptMaker** | Apresentações PPTX editáveis e fáceis de rever, a partir de um tema, de um esquema ou de um documento |
| | **ImageStudio** | Cartazes, capas, imagens para redes sociais e infografias |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narração, apresentadores criados por IA, legendas e dobragem, clipes com os melhores momentos, localização e recriação de vídeos de referência com os seus próprios conteúdos e imagens |
| | **VoiceStudio** | Narração, áudio com várias vozes, transcrições e legendas, edição e mistura de áudio |
| | **UIDesigner** | Interfaces editáveis baseadas em HTML, a partir de objetivos de produto, PRD, capturas de ecrã ou material do Figma |
| Desenvolvimento e escritório | **ProductDeveloper** | Engenharia que conhece o repositório: implementa um PRD, corrige erros, refatoriza e revê, com resultados verificáveis |
| | **OfficeWorker** | Cria, edita, verifica e entrega ficheiros Word / Excel / PowerPoint / PDF, um de cada vez ou em lote |
| Comércio eletrónico | **ECommerceResearcher** | Seleção de produtos por orçamento, mercado e limitações de aprovisionamento: candidatos, motivos de exclusão e planos de validação |
| | **ECommerceWriter** | Títulos, páginas de detalhe, perguntas frequentes, textos para imagens e guiões de vídeo com a voz da sua marca |
| | **ECommerceReviewer** | Análise de avaliações e reputação: temas recorrentes dos clientes, causas profundas das avaliações negativas e prioridades |
| | **ECommerceAnalyzer** | Vendas, lucros, anúncios, reembolsos e inventário a partir das suas exportações: métricas reconciliadas e decisões |
| | **ECommerceOperator** | Planeia alterações de catálogo, preços, promoções e inventário; executa-as apenas através das ferramentas que conectar |

Mais sobre cada agente → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Recriar um vídeo de referência com os seus próprios conteúdos

**VideoStudio** pode recriar a estrutura narrativa, o estilo visual e o ritmo de montagem de um vídeo viral com o seu próprio produto, guião e imagens. Forneça um ficheiro de vídeo de referência e os seus recursos: o agente analisa o gancho, a ordem da informação, os momentos visuais-chave e o apelo à ação e, antes da produção, propõe o que manter e o que substituir.

Funciona melhor com vídeos explicativos em motion graphics, demonstrações de SaaS ou de aplicações e anúncios de produtos criados a partir das imagens que já tem. Textos, legendas, narrações e clipes criados localmente podem ser revistos em separado; para alterar texto incorporado em imagens geradas por IA, é necessário alterar essas imagens.

> «Use o reference.mp4 como referência para um vídeo promocional vertical de 30 segundos. Mantenha o gancho, a tipografia e o ritmo, substitua o conteúdo pelo meu produto e pelas minhas gravações de ecrã, e mostre-me primeiro a análise e o plano.»

Comece com um ficheiro de vídeo que o agente consiga ler; a transferência a partir de ligações de partilha de redes sociais não está incluída. Não são garantidos movimentos de câmara exatos, interpretações humanas nem correspondência fotograma a fotograma. Consulte o [fluxo de trabalho de recriação de referências](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Manter o trabalho a avançar

Uma tarefa é um bom começo. O Orkas foi concebido para o trabalho que continua.

- **Projetos** — objetivos e regras, memória e ficheiros que servem de ponto de partida a todas as conversas do projeto, para que nunca tenha de explicar tudo do zero.
- **A fazer e Avanço automático** — cada projeto tem uma lista de tarefas a fazer para pessoas e agentes; com o Avanço automático ativo, a equipa assume sozinha o item seguinte e devolve o trabalho concluído para que o reveja.
- **Automações agendadas** — execute qualquer tarefa de hora a hora, diariamente, semanalmente ou mensalmente. O Orkas é executado no seu computador. A partir da v1.9, quando o computador sai do modo de suspensão ou o Orkas é iniciado, cada automação recupera a execução em falta mais recente das últimas 12 horas.
- **Conectores** — Gmail, Google Calendar, Sheets e Drive, Notion, Slack, Shopify, Stripe e muitos outros. Por predefinição, o Orkas pede confirmação antes de enviar, publicar ou eliminar o que quer que seja.
- **Aplicações** — descreva uma ferramenta e o Orkas cria-a como aplicação local dentro da aplicação para computador. Na aplicação instalável, os planos pagos também permitem publicá-la como aplicação web com uma ligação pública.
- **Projetos partilhados** *(aplicação instalável)* — convide um colega de equipa ou um assistente virtual e atribua cada tarefa a uma pessoa ou a um agente.

> [!NOTE]
> Os projetos partilhados, a sincronização na nuvem e a publicação de aplicações web só estão disponíveis na aplicação instalável; a versão de código aberto ainda não os suporta. Para os utilizar, **[transfira o Orkas para macOS e Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratuito, com 500 créditos para começar).

A entrada de voz também funciona na versão do código-fonte. Configure uma **Orkas API Key** em **Definições → Modelos** e clique no microfone junto à caixa de mensagem. Quando lhe for pedido, permita o acesso ao microfone. O áudio é enviado para o Orkas para reconhecimento e consome os créditos do Orkas do titular da chave. Clique novamente para parar, reveja o texto e envie-o manualmente. Se recusou o acesso, ative o microfone nas definições do sistema.

---

## Executar Claude Code, Codex, OpenCode, OpenClaw e Hermes-Agent em conjunto

O Orkas executa como sessões locais os agentes de CLI que já tem instalados, ao lado dos seus próprios especialistas: os agentes de programação **Claude Code, Codex e OpenCode** e os agentes pessoais **OpenClaw e Hermes-Agent**. O Commander atribui a cada um a parte em que é melhor e mantém um único plano para todos, pelo que uma única conversa pode corrigir o erro, rever a alteração e redigir a nota de versão. Ferramentas de código aberto como o HyperFrames integram-se da mesma forma.

[Utilizar Claude Code e Codex em conjunto →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Porquê o Orkas

- **Um Commander que planeia, delega e faz o resto** — decompõe os objetivos, escolhe os agentes, as competências, os conectores e as ferramentas certos e trata ele próprio da análise, da redação, da investigação e do trabalho com ficheiros quando nenhum especialista é mais indicado.
- **Concebido para dar prioridade ao funcionamento local** — as conversas, os ficheiros, as bases de conhecimento e os agentes personalizados ficam no seu disco por predefinição. A sincronização na nuvem é opcional na aplicação instalável. Com as suas próprias chaves, as chamadas aos modelos vão diretamente do seu computador para o fornecedor; o modelo integrado do Orkas funciona através do serviço de modelos gerido pelo Orkas.
- **Qualquer modelo, que pode trocar a qualquer momento** — o Commander e os agentes integrados partilham uma única definição de modelo: o modelo integrado do Orkas, o seu próprio fornecedor ou um endpoint local. Os agentes de CLI externos mantêm as suas próprias definições de modelo.
- **Agentes que melhoram** — cada agente mantém competências e memória privadas. As revisões em segundo plano analisam a nova atividade quando a aplicação está inativa e podem aperfeiçoar a autoavaliação, os métodos reutilizáveis e as competências aprendidas.
- **Código aberto, sem caixas negras** — licença MIT. Pode ler exatamente o que fazem o Orkas, cada agente e cada competência.

> ⭐ Se o Orkas lhe for útil, uma estrela ajuda mais pessoas a encontrar o projeto.

---

## Transferir

| | Aplicação instalável (recomendada) | Executar a partir do código-fonte |
| --- | --- | --- |
| Plataformas | macOS 12+ (Apple Silicon e Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 com glibc 2.34+ |
| Conta | Iniciar sessão — 500 créditos gratuitos | Nenhuma |
| Modelos | Modelo integrado do Orkas ou as suas próprias chaves | As suas próprias chaves ou um endpoint local |
| Inclui também | Colaboração em projetos, publicação de aplicações, sincronização na nuvem e muito mais | — |
| Obter | **[Transferir o Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Início rápido](#início-rápido) |

A ligação de transferência deteta o seu sistema e inicia o instalador adequado.

---

## Para que é utilizado

- **Conteúdos de marketing** — vídeos de lançamento, páginas de produto, publicações e newsletters com a sua voz. [Criação de conteúdos](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Vídeos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Gestão de lojas** — resumos semanais de vendas, respostas a avaliações, fichas de produto e análise da concorrência. [Comércio eletrónico](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Investigação e relatórios** — relatórios e apresentações com fontes, a pedido ou todas as semanas. [Investigação](https://orkas.ai/use/researchers/?source=gh-orkas) · [Análise de dados](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Converse com os seus documentos** — respostas fundamentadas nos seus próprios ficheiros, com citações que remetem para os excertos de origem. [Conversar com documentos](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Trabalho para clientes** — notas de preparação de reuniões, relatórios mensais para clientes e apresentações de ponto de situação no seu modelo. [Modelo de relatório mensal para clientes](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lançamento de produtos** — páginas de destino, correções de erros com testes, registos de alterações e publicações de lançamento. [Programadores](https://orkas.ai/use/developers/?source=gh-orkas)
- **Criar uma aplicação** — calculadoras de orçamentos, formulários de reserva, ferramentas internas. [Criar aplicações](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Equipas pequenas** — um único projeto para pessoas e agentes. [Equipas pequenas](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Como o Orkas se compara

| Ferramenta | O que é | Em que o Orkas é diferente |
| --- | --- | --- |
| **Claude Code** | A ferramenta de programação agêntica da Anthropic — no terminal, no IDE, no computador e na web, baseada nos modelos Claude. | Não é preciso escolher: o Orkas executa o Claude Code como um dos seus agentes. À volta dele, o Orkas acrescenta uma equipa independente do modelo para o trabalho que vai além do código (investigação, conteúdos, vídeo e muito mais), com projetos, tarefas a fazer e automações que mantêm o trabalho a avançar. [Orkas vs. Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | O agente de programação da OpenAI — no terminal, no seu editor e na nuvem. | Não é preciso escolher: o Orkas executa o Codex como um dos seus agentes, ao lado do Claude Code e do OpenCode. O Commander pode atribuir a programação ao Codex e a revisão a outro agente e, depois, tratar da metade de um lançamento que não é código: documentação, publicações de lançamento e vídeos. [Orkas vs. Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | O agente da Anthropic para o trabalho do dia a dia, agora parte do Claude — no computador, na web e no telemóvel, com um plano pago do Claude. Por predefinição, é executado na nuvem da Anthropic e utiliza modelos Claude. | Uma alternativa de código aberto (MIT) ao Claude Cowork, que pode começar a utilizar gratuitamente, com 500 créditos. O Orkas executa os próprios agentes no seu computador e, por predefinição, mantém os seus dados localmente, com o modelo integrado do Orkas, as chaves do seu próprio fornecedor ou um endpoint local. O Commander também pode chamar o Claude Code, o Codex e outros agentes de CLI. A contrapartida: o Orkas precisa que o seu computador esteja ligado e ativo, enquanto as tarefas na nuvem do Cowork podem continuar a ser executadas sem ele. [Alternativas ao Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Um agente de IA que, por predefinição, planeia e executa tarefas na nuvem do Manus. A aplicação para computador Manus Studio (macOS e Windows) também pode trabalhar numa pasta à sua escolha, embora as tarefas continuem a ser planeadas na nuvem. | Uma alternativa de código aberto (MIT) ao Manus. O Orkas executa os próprios agentes no seu computador e, por predefinição, mantém os seus dados localmente, com o modelo integrado do Orkas, as chaves do seu próprio fornecedor ou um endpoint local. Os projetos, as tarefas a fazer e as automações mantêm o trabalho a avançar. A contrapartida: o Orkas precisa que o seu computador esteja ligado e ativo, enquanto as tarefas na nuvem do Manus podem continuar a ser executadas sem ele. [Alternativa de código aberto ao Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Uma framework/biblioteca para programadores criarem aplicações e agentes com LLM — centrada no código e incorporada na sua própria aplicação Python/JS. | O Orkas é uma aplicação para computador que o utilizador dirige através da conversa, sem escrever código de orquestração. Por predefinição, os dados ficam armazenados localmente. |
| **CrewAI** | Uma framework Python para orquestrar agentes autónomos que desempenham papéis — as equipas (crews) e os agentes são definidos em código. | O Orkas leva a orquestração multiagente para uma aplicação para computador, com projetos, tarefas a fazer, automações e automelhoria por agente já integrados. |
| **OpenClaw** | Uma plataforma de agentes pessoais com integrações de mensagens, encaminhamento multiagente e subagentes. | O Orkas oferece um espaço de trabalho no computador para resultados finais, com especialistas integrados e coordenação entre o Claude Code, o Codex, o OpenCode e outros agentes de CLI. O OpenClaw pode juntar-se a esse fluxo de trabalho como agente de CLI. |
| **Hermes-Agent** | O agente da Nous Research que se aperfeiçoa a si próprio — um único agente com memória e competências, disponível como CLI, gateway de mensagens e aplicação para computador. | O Orkas coordena uma equipa: o Commander dirige muitos especialistas e outros agentes de CLI, e o Hermes-Agent integra-se como um deles. |

**O Orkas é para si se** pretende uma equipa de agentes em vez de um único assistente, trabalho que continue a avançar ao longo de vários dias, e os seus dados, chaves e agentes no seu próprio disco.

**Não é para si se** apenas pretende um único chatbot para tudo ou uma biblioteca de código pura para incorporar na sua própria aplicação.

**Está a escolher entre agentes de programação?** [Codex vs. OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs. Codex vs. OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternativas ao Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Comparações completas lado a lado →** [vs. Claude Code](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) · [vs. Codex](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) · [vs. Cline](https://orkas.ai/compare/orkas-vs-cline/?source=gh-orkas) · [vs. LangChain](https://orkas.ai/compare/orkas-vs-langchain/?source=gh-orkas) · [vs. ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt/?source=gh-orkas) · [vs. OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw/?source=gh-orkas) · [vs. Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent/?source=gh-orkas)

---

## Início rápido

Prefere um instalador pronto a usar? Consulte [Transferir](#transferir) acima. Para executar a partir do código-fonte, que é atualmente a forma de executar o Orkas em Linux:

**Requisitos**: Node 22.12+ · macOS / Windows 10+ / Linux x64 ou arm64 com glibc 2.34+. Mantenha disponíveis o Python 3 e uma cadeia de ferramentas de compilação C/C++ para o caso, pouco frequente, de ser necessário compilar os módulos nativos a partir do código-fonte.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

A execução a partir do código-fonte em Linux requer glibc 2.34+. O Alpine e outras distribuições baseadas em musl não são suportados. A transcrição de voz local transfere e verifica o ambiente de execução do whisper.cpp nativo da plataforma de destino e o modelo multilingue durante o primeiro arranque a partir do código-fonte.

`run.sh` / `run.cmd` instala a árvore de dependências npm com versões bloqueadas e, no primeiro arranque, prepara as versões fixadas do Python, do uv, do Node, do modelo de embeddings (~95 MB), do OfficeCLI, do FFmpeg, do whisper.cpp e dos recursos do modelo de voz multilingue. Em seguida, o arranque em Linux verifica os módulos nativos da plataforma e o ambiente de execução do Whisper com a ABI do Electron antes de abrir a aplicação. Os pacotes Python de OCR e os específicos de cada competência são instalados em ambientes locais isolados na primeira vez que essas funcionalidades são utilizadas. O primeiro arranque cria um espaço de trabalho em `~/.orkas/` (macOS / Linux) ou `<smallest non-system drive>:\.orkas\` (Windows). Depois, abra **Definições → Fornecedores de IA** para adicionar uma chave de API ou OAuth.

Erros de dependências nativas: utilize o Node.js 24 LTS (mínimo 22.12.0) e, em seguida, execute
`npm run native:repair` a partir desta cópia do repositório. Este comando restaura os pacotes opcionais,
repara o SQLite para o Electron, prepara o Node incluído para o processamento isolado de imagens
e verifica o SQL, o sqlite-vec e o sharp antes de indicar sucesso.
Utilize `npm run native:check` para fazer uma verificação sem instalar nada.
Consulte o [script de verificação de dependências nativas](./scripts/verify-native-dependencies.cjs) para ver as verificações efetuadas.

---

## Como funciona

### Encaminhamento de tarefas

O Commander trata ele próprio do trabalho geral e delega o trabalho especializado através de três ferramentas:

- **`dispatch_to`** executa um agente com nome e devolve o respetivo resultado para que o trabalho continue. Pode aguardar o resultado ou ser executado de forma assíncrona e notificar o Commander quando a tarefa terminar.
- **`hand_off_to`** transfere o trabalho restante para um agente com nome e termina o turno atual do Commander. O agente entrega a sua própria resposta; uma continuação opcional permite ao Commander retomar mais tarde uma tarefa mais abrangente.
- **`run_worker`** executa uma subtarefa anónima e isolada e devolve um resultado privado. Não recebe o histórico da conversa nem as competências de um agente com nome.

As tarefas de agentes com nome e os workers anónimos têm controlos de concorrência separados. Consulte a [implementação do despacho](./src/main/features/group_chat/bus.ts) e os [bloqueios de execução](./src/main/util/locks.ts).

### Gestão do contexto

O ambiente de execução gere o orçamento de contexto em função da capacidade de entrada utilizável do modelo selecionado, tendo em conta os prompts, as ferramentas e o estado persistente do ambiente de execução. Os diálogos concluídos utilizam uma janela limitada de histórico recente; as tarefas ativas longas utilizam pontos de controlo para condensar as mensagens anteriores do processo, mantendo o trabalho recente. As leituras de ficheiros, as alterações de ficheiros e as execuções de comandos também têm registos estruturados que podem sobreviver à compactação do contexto.

Consulte [orçamentos de contexto](./src/core-agent/src/agent/context-budget.ts), [histórico de sessão e pontos de controlo](./src/core-agent/src/agent/session.ts) e [registos do espaço de trabalho](./src/core-agent/src/agent/workspace-state.ts).

### A memória e a Biblioteca

As notas persistentes guardam as preferências do utilizador, os factos do projeto e o conhecimento reutilizável de cada agente em âmbitos separados. Estas notas são distintas do índice de documentos da Biblioteca e do histórico de conversas guardado.

A Biblioteca divide os documentos em excertos e guarda um índice vetorial local em SQLite. O respetivo modelo de embeddings é executado no seu computador; a ferramenta `library` pode listar ficheiros, pesquisar excertos relevantes e ler o conteúdo original da Biblioteca global ou da Biblioteca do projeto atual. As conversas anteriores são obtidas separadamente através de `chat_history`.

Consulte [memória por âmbito](./src/main/features/memory.ts), [extração de documentos](./src/main/util/file_to_chunks.ts), [ferramentas da Biblioteca](./src/main/model/core-agent/kb-tools.ts) e [recuperação de conversas](./src/main/model/core-agent/chat-history-tools.ts).

### Limites de execução e recuperação

Os bloqueios de sessão e os limites de concorrência restringem o trabalho em paralelo. Os orçamentos de rondas de ferramentas, os pontos de controlo de progresso, as verificações de chamadas repetidas e os watchdogs de inatividade sensíveis à fase ajudam a conter as execuções que ficam bloqueadas ou repetem trabalho. As tarefas de agentes com nome podem ser acompanhadas e canceladas individualmente; uma tarefa aceite ou em fila de espera não é tratada como resultado concluído.

Consulte [orçamentos de atores](./src/main/features/group_chat/actor-budgets.ts), o [ambiente de execução dos agentes](./src/core-agent/src/agent/runner.ts) e o [adaptador de modelos da aplicação para computador](./src/main/model/core-agent/client.ts).

### Aprendizagem a partir da atividade

As revisões em segundo plano analisam a nova atividade dos agentes quando a aplicação está inativa, sujeitas a períodos de espera e a limites de execução. Uma revisão pode atualizar a autoavaliação de um agente (`COMPETENCE.md`), os métodos reutilizáveis (`LEARNING_STRATEGIES.md`) ou as competências aprendidas. As revisões dependem de nova atividade, e não do número de tarefas, e podem concluir que não há nada que valha a pena guardar.

Consulte o [agendador de reflexão](./src/main/features/reflection-orchestrator.ts) e o [prompt de revisão](./src/core-agent/src/evolution/metacognition.ts).

---

## Perguntas frequentes

**O que é o Orkas?**
O Orkas é uma aplicação multiagente para computador, de código aberto (MIT), que dá prioridade ao funcionamento local. O Commander do Orkas transforma o seu objetivo em tarefas a fazer e coordena 16 agentes especialistas integrados — além do Claude Code, do Codex, do OpenCode, do OpenClaw e do Hermes-Agent — para entregar ficheiros concluídos. Não é um chatbot único, nem uma framework de código, nem um SaaS alojado.

**Preciso de uma chave de API?**
Não. A aplicação instalável inclui 500 créditos para o modelo integrado do Orkas. Depois disso, pode comprar créditos, escolher um plano pago ou adicionar as chaves do seu próprio fornecedor; os custos do fornecedor são cobrados à parte.

**O Orkas é um LLM local?**
Não. O Orkas é executado no seu computador e chama os modelos que escolher: o modelo integrado do Orkas, as suas próprias chaves de API ou um endpoint de modelo local. Orquestra agentes e ferramentas; não é, em si, um modelo.

**O Orkas consegue responder a perguntas com base nos meus documentos, com citações?**
Sim. Adicione PDF e outros documentos à sua Biblioteca local; o Orkas pode pesquisá-los e responder com citações dos excertos de origem, para que possa abrir o original e confirmar. O índice é criado no seu computador.

**Posso utilizar modelos locais como o Ollama ou o LM Studio?**
Sim. Abra **Definições da conta → Modelos → Conversa → Adicionar modelo → Personalizado**, selecione **Compatível com OpenAI** ou **Compatível com Anthropic** e introduza o URL base, o ID exato do modelo e a chave de API. Escolha o modelo guardado no seletor de modelos da tarefa.

**Onde ficam as minhas chaves de API e os meus dados?**
No seu disco, por predefinição. As chaves do seu próprio fornecedor são encriptadas localmente e excluídas da sincronização na nuvem. Com as suas próprias chaves, as chamadas aos modelos vão diretamente do seu computador para o fornecedor; o modelo integrado do Orkas utiliza o serviço gerido do Orkas. A sincronização na nuvem opcional e os projetos partilhados da aplicação instalável guardam os dados selecionados nos servidores do Orkas. [Segurança e tratamento de dados →](https://orkas.ai/security/?source=gh-orkas)

**O Orkas funciona sem ligação à Internet?**
A versão do código-fonte pode funcionar totalmente sem ligação à Internet com um endpoint de modelo local. A aplicação instalável precisa de iniciar sessão e os modelos na nuvem precisam de ligação à rede.

**Continua a funcionar quando o meu computador está desligado?**
Não — o Orkas é executado no seu computador, pelo que o Avanço automático e as automações precisam do computador ligado e ativo e do Orkas em execução. A partir da v1.9, quando o computador sai do modo de suspensão ou o Orkas é iniciado, cada automação recupera a execução em falta mais recente das últimas 12 horas.

**Posso criar e publicar aplicações?**
Sim. As aplicações locais executadas dentro do Orkas são gratuitas. Publicar uma aplicação web numa ligação pública requer um plano pago (Lite 5, Pro 8, Max 15 aplicações) e as aplicações web publicadas não incluem todas as capacidades disponíveis dentro do Orkas.

**Preciso de uma conta Orkas?**
A aplicação para computador instalável pede-lhe que inicie sessão quando a abre pela primeira vez. A versão do código-fonte deste repositório não tem qualquer camada de contas — arranca diretamente na aplicação.

**O Orkas consegue controlar o Claude Code e outros agentes de CLI?**
Sim. O Orkas pode controlar cinco agentes de CLI externos como subprocessos locais — os agentes de programação Claude Code, Codex e OpenCode, além dos agentes pessoais OpenClaw e Hermes-Agent — e integrar projetos de código aberto como o HyperFrames, tudo dirigido a partir da mesma conversa.

**Em que é que o Orkas é diferente do Claude Code / Codex / CrewAI / LangChain?**
O Claude Code e o Codex são agentes de programação — o Orkas executa ambos como membros da própria equipa, pelo que não tem de escolher entre eles; o CrewAI e o LangChain são frameworks centradas no código. O Orkas é uma aplicação de código aberto para computador em que um Commander coordena uma equipa de agentes especialistas e os seus agentes de CLI, com qualquer fornecedor de modelos, e mantém os dados e as chaves localmente. Consulte as [comparações completas](https://orkas.ai/compare/?source=gh-orkas).

**Que plataformas são suportadas pelo Orkas?**
macOS 12+ (Apple Silicon e Intel) e Windows 10+ têm instaladores. Linux x64/arm64 com glibc 2.34+ é executado hoje a partir do código-fonte, ainda sem instalador. A transcrição de voz local é suportada em Linux através do ambiente de execução fixado do whisper.cpp, preparado no primeiro arranque. O Alpine e outras distribuições baseadas em musl não são suportados. O arranque a partir do código-fonte requer Node 22.12+; o Python 3 e uma cadeia de ferramentas de compilação C/C++ só são necessários quando um pacote npm nativo não tem um binário pré-compilado compatível e tem de ser recompilado localmente.

**O Orkas é gratuito e de código aberto?**
Sim — a aplicação tem licença MIT e é de utilização gratuita. A aplicação instalável inclui 500 créditos para o modelo integrado do Orkas; os planos pagos, a partir de $11.99/mês, acrescentam créditos mensais, sincronização na nuvem, mais projetos partilhados e publicação de aplicações. Com as suas próprias chaves, a utilização dos modelos é faturada pelo seu fornecedor; o Orkas não acrescenta qualquer margem. [Preços →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licença

[MIT](./LICENSE)
