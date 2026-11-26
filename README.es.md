# Orkas

**Un equipo de agentes de IA de código abierto en tu escritorio: convierte tus objetivos en trabajo terminado y lo mantiene en marcha.**

Orkas es una aplicación de escritorio multiagente, de código abierto (MIT) y con prioridad local: un asistente de IA que trabaja como un equipo. Dile al **Commander** lo que necesitas: completa muchas tareas por su cuenta y, para los trabajos más grandes, planifica los pasos e incorpora agentes especializados, junto con los agentes de programación y personales que ya usas (**Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent**), para que trabajen juntos en ello.

Orkas está pensado para que un proyecto siga avanzando, no solo para responder a una única petición. Un **proyecto** reúne el objetivo, las reglas, la memoria y los archivos, de modo que cada conversación nueva retoma el trabajo donde lo dejó la anterior. La lista de **Pendientes** reparte el trabajo entre personas y agentes, el **Avance automático** permite que el equipo se encargue por sí solo del siguiente pendiente y las **automatizaciones programadas** repiten el trabajo rutinario cada hora, cada día, cada semana o cada mes. Todos tus datos se quedan en tu ordenador y el trabajo terminado vuelve a ti para que lo revises; así puedes confiar a Orkas el trabajo continuo de tu negocio.

**[⬇ Descargar Orkas para macOS y Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** — gratis, con 500 créditos para el modelo integrado de Orkas, así que no necesitas una clave de API para empezar. ¿Prefieres usar tus propias claves? Claude · OpenAI · Gemini · DeepSeek · Kimi · GLM · Qwen · MiniMax · Doubao, o un endpoint local compatible con OpenAI.

[![Download for macOS & Windows](https://img.shields.io/badge/Download-macOS%20%26%20Windows-5b57d6?style=for-the-badge)](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Orkas-AI/Orkas?style=flat&logo=github&label=Stars&color=yellow)](https://github.com/Orkas-AI/Orkas/stargazers)
[![Release](https://img.shields.io/github/v/release/Orkas-AI/Orkas?color=blue)](https://github.com/Orkas-AI/Orkas/releases)
[![X: @leochenpm](https://img.shields.io/badge/X-%40leochenpm-black?logo=x)](https://x.com/leochenpm)
[![Website: orkas.ai](https://img.shields.io/badge/Website-orkas.ai-5b57d6)](https://orkas.ai/?source=gh-orkas)

[English](./README.en.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Español](./README.es.md) · [Bahasa Indonesia](./README.id.md) · [Español (Latinoamérica)](./README.es-419.md) · [Русский](./README.ru.md) · [Português (Brasil)](./README.pt-BR.md) · [Türkçe](./README.tr.md) · [繁體中文](./README.zh-TW.md) · [Tiếng Việt](./README.vi.md) · [Deutsch](./README.de.md) · [ไทย](./README.th.md) · [Français](./README.fr.md) · [Italiano](./README.it.md) · [Português (Portugal)](./README.pt-PT.md) · [العربية](./README.ar.md)

---

https://github.com/user-attachments/assets/4f8b16c8-a192-45a4-b19f-80e8d02c3dab

![Aplicación de escritorio de Orkas: conversación de una tarea y entregables](./resources/app-ui/task-en.png)

---

## Lo que entrega el equipo

- **Vídeos, locuciones e imágenes** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Informes de investigación, auditorías SEO y análisis de mercado** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Publicaciones, artículos, boletines y presentaciones** — ContentWriter, PptMaker
- **Sitios web, interfaces y código** — UIDesigner, ProductDeveloper
- **Archivos de Word, Excel, PowerPoint y PDF** — OfficeWorker
- **Comercio electrónico** — investigación de productos, fichas de producto, análisis de reseñas, análisis de ventas y cambios en el catálogo, a cargo de cinco agentes de comercio electrónico
- **Trabajos complejos que requieren varios agentes** — el Commander los divide, asigna cada parte al agente adecuado y combina los resultados; por ejemplo, un estudio de mercado que se convierte en un informe, una presentación y un vídeo de lanzamiento

La aplicación incluye 16 especialistas, cada uno con sus propias habilidades, memoria y herramientas. Explora más de 30 agentes en el [marketplace de agentes](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) o describe el rol que necesitas y el Commander creará un agente personalizado para ti.

<details>
<summary><b>Los 16 agentes integrados</b></summary>

| Área | Agente | Qué entrega |
| --- | --- | --- |
| Investigación y análisis | **DeepResearcher** | Investigación basada en evidencias, con fuentes verificadas, contradicciones señaladas y un informe auditable |
| | **SeoGeoAgent** | Dale una URL: auditoría técnica, calidad del contenido, Core Web Vitals, capacidad de ser citado en respuestas de IA (GEO) y lista de correcciones por prioridad |
| | **StockAnalyser** | Análisis de acciones, cribado por factores, backtests y control de riesgos de la cartera, con paneles trazables |
| Contenido y multimedia | **ContentWriter** | Publicaciones, artículos, boletines y casos prácticos listos para publicar a partir de un objetivo, unas fuentes o un borrador |
| | **PptMaker** | Presentaciones PPTX editables y fáciles de revisar a partir de un tema, un esquema o un documento |
| | **ImageStudio** | Carteles, portadas, imágenes para redes sociales e infografías |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narración, presentadores con IA, subtítulos y doblaje, clips con los mejores momentos, localización y recreación de vídeos de referencia con tu propio contenido y material grabado |
| | **VoiceStudio** | Narración, audio con varias voces, transcripciones y subtítulos, edición y mezcla de audio |
| | **UIDesigner** | Interfaces editables construidas sobre HTML a partir de objetivos de producto, PRD, capturas de pantalla o material de Figma |
| Desarrollo y oficina | **ProductDeveloper** | Ingeniería que conoce tu repositorio: implementa un PRD, corrige errores, refactoriza y revisa, con resultados verificables |
| | **OfficeWorker** | Crea, edita, revisa y entrega archivos Word / Excel / PowerPoint / PDF, de uno en uno o por lotes |
| Comercio electrónico | **ECommerceResearcher** | Selección de productos según presupuesto, mercado y limitaciones de aprovisionamiento: candidatos, motivos de descarte y planes de validación |
| | **ECommerceWriter** | Títulos, páginas de detalle, preguntas frecuentes, textos para imágenes y guiones de vídeo con la voz de tu marca |
| | **ECommerceReviewer** | Análisis de reseñas y reputación: temas recurrentes de los clientes, causas de fondo de las malas reseñas y prioridades |
| | **ECommerceAnalyzer** | Ventas, beneficios, anuncios, reembolsos e inventario a partir de tus exportaciones: métricas conciliadas y decisiones |
| | **ECommerceOperator** | Planifica cambios de catálogo, precios, promociones e inventario; solo los ejecuta mediante las herramientas que conectes |

Más sobre cada agente → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Recrea un vídeo de referencia con tu propio contenido

**VideoStudio** puede recrear la estructura narrativa, el estilo visual y el ritmo de montaje de un vídeo viral con tu propio producto, guion y material grabado. Aporta un archivo de vídeo de referencia y tus recursos: el agente analiza el gancho, el orden de la información, los momentos visuales clave y la llamada a la acción, y antes de la producción propone qué conservar y qué sustituir.

Funciona mejor con vídeos explicativos de motion graphics, demostraciones de SaaS o de aplicaciones y anuncios de producto creados a partir del material grabado que ya tienes. Los textos, subtítulos, narraciones y clips creados localmente se pueden revisar por separado; para cambiar el texto incrustado en metraje generado por IA hay que cambiar ese metraje.

> «Usa reference.mp4 como referencia para un vídeo promocional vertical de 30 segundos. Mantén su gancho, su tipografía y su ritmo, sustituye el contenido por mi producto y mis grabaciones de pantalla, y enséñame primero el desglose y el plan.»

Empieza con un archivo de vídeo que el agente pueda leer; la descarga desde enlaces compartidos de redes sociales no está integrada. No se garantiza reproducir con exactitud los movimientos de cámara ni las actuaciones de personas, ni una coincidencia fotograma a fotograma. Consulta el [flujo de trabajo de recreación de referencias](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Mantén el trabajo en marcha

Una tarea es un buen comienzo. Orkas está pensado para el trabajo que continúa.

- **Proyectos** — objetivos y reglas, memoria y archivos de los que parte cada conversación del proyecto, para que nunca tengas que explicarlo todo desde cero.
- **Pendientes y Avance automático** — cada proyecto tiene una lista de pendientes para personas y agentes; con el Avance automático activado, el equipo se encarga por sí solo del siguiente elemento y te devuelve el trabajo terminado para que lo revises.
- **Automatizaciones programadas** — ejecuta cualquier tarea cada hora, cada día, cada semana o cada mes. Orkas se ejecuta en tu ordenador. Desde la v1.9, cuando el ordenador se reactiva o se inicia Orkas, cada automatización recupera su ejecución perdida más reciente de las 12 horas anteriores.
- **Conectores** — Gmail, Google Calendar, Sheets y Drive, Notion, Slack, Shopify, Stripe y muchos más. De forma predeterminada, Orkas pide confirmación antes de enviar, publicar o eliminar cualquier cosa.
- **Aplicaciones** — describe una herramienta y Orkas la crea como app local dentro de la aplicación de escritorio. En la aplicación instalable, los planes de pago también pueden publicarla como aplicación web con un enlace público.
- **Proyectos compartidos** *(aplicación instalable)* — invita a un compañero de equipo o a un asistente virtual, y asigna cada pendiente a una persona o a un agente.

> [!NOTE]
> Los proyectos compartidos, la sincronización en la nube y la publicación de aplicaciones web solo están en la aplicación instalable; la versión de código abierto todavía no los admite. Para usarlos, **[descarga Orkas para macOS y Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratis, con 500 créditos para empezar).

La entrada de voz también funciona en la versión de código fuente. Configura una **Orkas API Key** en **Configuración → Modelos** y haz clic en el micrófono junto al cuadro de texto. Cuando se te pida, permite el acceso al micrófono. El audio se envía a Orkas para su reconocimiento y consume los créditos de Orkas del titular de la clave. Vuelve a hacer clic para detener la grabación, revisa el texto y envíalo tú mismo. Si has denegado el acceso, activa el micrófono en los ajustes del sistema.

---

## Ejecuta Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent juntos

Orkas ejecuta como sesiones locales los agentes de CLI que ya tienes instalados, junto a sus propios especialistas: los agentes de programación **Claude Code, Codex y OpenCode** y los agentes personales **OpenClaw y Hermes-Agent**. El Commander asigna a cada uno la parte que mejor se le da y mantiene un único plan para todos, de modo que en un mismo chat se puede corregir el error, revisar el cambio y redactar la nota de la versión. Las herramientas de código abierto como HyperFrames se conectan de la misma forma.

[Cómo usar Claude Code y Codex juntos →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Por qué Orkas

- **Un Commander que planifica, delega y hace el resto** — desglosa los objetivos, elige los agentes, las habilidades, los conectores y las herramientas adecuados, y se encarga él mismo del análisis, la redacción, la investigación y el trabajo con archivos cuando ningún especialista encaja mejor.
- **Diseñado con prioridad local** — las conversaciones, los archivos, las bases de conocimiento y los agentes personalizados se quedan en tu disco de forma predeterminada. La sincronización en la nube es opcional en la aplicación instalable. Con tus propias claves, las llamadas al modelo van directamente de tu equipo al proveedor; el modelo integrado de Orkas funciona a través del servicio de modelos gestionado por Orkas.
- **Cualquier modelo, y puedes cambiarlo cuando quieras** — el Commander y los agentes integrados comparten una misma configuración de modelo: el modelo integrado de Orkas, tu propio proveedor o un endpoint local. Los agentes de CLI externos mantienen su propia configuración de modelo.
- **Agentes que mejoran** — cada agente conserva habilidades y memoria privadas. Las revisiones en segundo plano examinan la actividad nueva cuando la aplicación está inactiva y pueden afinar la autoevaluación, los métodos reutilizables y las habilidades aprendidas.
- **Código abierto, sin cajas negras** — con licencia MIT. Puedes leer exactamente qué hacen Orkas, cada agente y cada habilidad.

> ⭐ Si Orkas te resulta útil, una estrella ayuda a que más gente encuentre el proyecto.

---

## Descarga

| | Aplicación instalable (recomendada) | Ejecutar desde el código fuente |
| --- | --- | --- |
| Plataformas | macOS 12+ (Apple Silicon e Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 con glibc 2.34+ |
| Cuenta | Inicio de sesión: 500 créditos gratis | No necesaria |
| Modelos | Modelo integrado de Orkas o tus propias claves | Tus propias claves o un endpoint local |
| También incluye | Colaboración en proyectos, publicación de aplicaciones, sincronización en la nube y más | — |
| Cómo conseguirla | **[Descargar Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Inicio rápido](#inicio-rápido) |

El enlace de descarga detecta tu sistema e inicia el instalador adecuado.

---

## Para qué se usa

- **Contenido de marketing** — vídeos de lanzamiento, páginas de producto, publicaciones y boletines con tu propio estilo. [Redacción de contenidos](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Vídeos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Gestión de tiendas** — resúmenes semanales de ventas, respuestas a reseñas, fichas de producto y seguimiento de la competencia. [Comercio electrónico](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Investigación e informes** — informes y presentaciones con fuentes, cuando los necesites o cada semana. [Investigación](https://orkas.ai/use/researchers/?source=gh-orkas) · [Análisis de datos](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Chatea con tus documentos** — respuestas basadas en tus propios archivos, con citas que remiten a los fragmentos de origen. [Chatear con documentos](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Trabajo para clientes** — notas de preparación de reuniones, informes mensuales para clientes y presentaciones de seguimiento con tu plantilla. [Plantilla de informe mensual para clientes](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lanzamiento de productos** — páginas de destino, correcciones de errores con pruebas, registros de cambios y publicaciones de lanzamiento. [Desarrolladores](https://orkas.ai/use/developers/?source=gh-orkas)
- **Crea una aplicación** — calculadoras de presupuestos, formularios de reserva, herramientas internas. [Crear aplicaciones](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Equipos pequeños** — un solo proyecto para personas y agentes. [Equipos pequeños](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Orkas frente a otras herramientas

| Herramienta | Qué es | En qué se diferencia Orkas |
| --- | --- | --- |
| **Claude Code** | La herramienta de programación agéntica de Anthropic, disponible en el terminal, el IDE, el escritorio y la web, basada en los modelos Claude. | No hay que elegir entre uno y otro: Orkas ejecuta Claude Code como uno de sus agentes. A su alrededor, Orkas añade un equipo independiente del modelo para el trabajo que va más allá del código (investigación, contenido, vídeo y más), con proyectos, pendientes y automatizaciones que lo mantienen en marcha. [Orkas vs. Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | El agente de programación de OpenAI, disponible en el terminal, en tu editor y en la nube. | No hay que elegir entre uno y otro: Orkas ejecuta Codex como uno de sus agentes, junto a Claude Code y OpenCode. El Commander puede encargar la programación a Codex y la revisión a otro agente, y después ocuparse de la otra mitad de un lanzamiento, la que no es código: documentación, publicaciones de lanzamiento y vídeos. [Orkas vs. Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | El agente de Anthropic para el trabajo cotidiano, ahora integrado en Claude: disponible en escritorio, web y móvil con un plan de pago de Claude. De forma predeterminada se ejecuta en la nube de Anthropic y usa modelos Claude. | Una alternativa de código abierto (MIT) a Claude Cowork que puedes empezar a usar gratis, con 500 créditos. Orkas ejecuta sus agentes en tu ordenador y, de forma predeterminada, mantiene tus datos en local, con el modelo integrado de Orkas, las claves de tu propio proveedor o un endpoint local. El Commander también puede incorporar Claude Code, Codex y otros agentes de CLI. La contrapartida: Orkas necesita que tu ordenador esté encendido y activo, mientras que las tareas en la nube de Cowork pueden seguir ejecutándose sin él. [Alternativas a Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Un agente de IA que, de forma predeterminada, planifica y ejecuta tareas en la nube de Manus. La aplicación de escritorio Manus Studio (macOS y Windows) también puede trabajar en una carpeta que elijas, aunque las tareas se siguen planificando en la nube. | Una alternativa de código abierto (MIT) a Manus. Orkas ejecuta sus agentes en tu ordenador y, de forma predeterminada, mantiene tus datos en local, con el modelo integrado de Orkas, las claves de tu propio proveedor o un endpoint local. Los proyectos, los pendientes y las automatizaciones mantienen el trabajo en marcha. La contrapartida: Orkas necesita que tu ordenador esté encendido y activo, mientras que las tareas en la nube de Manus pueden seguir ejecutándose sin él. [Alternativa de código abierto a Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Un framework/biblioteca para desarrolladores con el que crear aplicaciones y agentes basados en LLM; está centrado en el código y se integra en tu propia aplicación Python/JS. | Orkas es una aplicación de escritorio que diriges desde el chat, sin escribir código de orquestación. Los datos se quedan en local de forma predeterminada. |
| **CrewAI** | Un framework de Python para orquestar agentes autónomos que desempeñan roles; los equipos (crews) y los agentes se definen en código. | Orkas lleva la orquestación multiagente a una aplicación de escritorio, con proyectos, pendientes, automatizaciones y automejora por agente integrados. |
| **OpenClaw** | Una plataforma de agentes personales con integraciones de mensajería, enrutamiento multiagente y subagentes. | Orkas ofrece un espacio de trabajo de escritorio para obtener entregables terminados, con especialistas integrados y coordinación entre Claude Code, Codex, OpenCode y otros agentes de CLI. OpenClaw puede sumarse a ese flujo de trabajo como agente de CLI. |
| **Hermes-Agent** | El agente de Nous Research que se mejora a sí mismo: un único agente con memoria y habilidades, disponible como CLI, como pasarela de mensajería y como aplicación de escritorio. | Orkas coordina un equipo: el Commander dirige a muchos especialistas y a otros agentes de CLI, y Hermes-Agent se integra como uno más de ellos. |

**Orkas es para ti si** quieres un equipo de agentes en lugar de un único asistente, un trabajo que siga avanzando durante días, y tus datos, claves y agentes en tu propio disco.

**No es para ti si** solo quieres un único chatbot para todo o una biblioteca de código pura para integrar en tu propia aplicación.

**¿Dudas entre agentes de programación?** [Codex vs. OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs. Codex vs. OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternativas a Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Comparativas completas, punto por punto →** [frente a Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [frente a Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [frente a Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [frente a LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [frente a ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [frente a OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [frente a Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Inicio rápido

¿Prefieres un instalador listo para usar? Consulta [Descarga](#descarga) más arriba. Para ejecutar Orkas desde el código fuente, que por ahora es la forma de usarlo en Linux:

**Requisitos**: Node 22.12+ · macOS / Windows 10+ / Linux x64 o arm64 con glibc 2.34+. Ten a mano Python 3 y una cadena de herramientas de compilación de C/C++ para el caso poco habitual de que haya que compilar los módulos nativos desde el código fuente.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

Las ejecuciones desde el código fuente en Linux requieren glibc 2.34+. Alpine y otras distribuciones basadas en musl no son compatibles. Durante el primer arranque desde el código fuente, la transcripción de voz local descarga y verifica el entorno de ejecución de whisper.cpp nativo de la plataforma de destino y el modelo multilingüe.

`run.sh` / `run.cmd` instala el árbol de dependencias de npm con versiones bloqueadas y, en el primer arranque, prepara con versiones fijadas Python, uv, Node, el modelo de embeddings (~95 MB), OfficeCLI, FFmpeg, whisper.cpp y los recursos del modelo de voz multilingüe. Después, en Linux, el arranque verifica los módulos nativos de la plataforma y el entorno de ejecución de Whisper con la ABI de Electron antes de abrir la aplicación. Los paquetes de Python para OCR y los específicos de cada habilidad se instalan en entornos locales aislados la primera vez que se usan esas funciones. El primer arranque crea un espacio de trabajo en `~/.orkas/` (macOS / Linux) o en `<smallest non-system drive>:\.orkas\` (Windows). A continuación, abre **Configuración → Proveedores de IA** para añadir una clave de API u OAuth.

Errores de dependencias nativas: usa Node.js 24 LTS (mínimo 22.12.0) y después ejecuta
`npm run native:repair` desde esta copia del repositorio. Esto restaura los paquetes opcionales,
repara SQLite para Electron, prepara el Node incluido para el procesamiento aislado de imágenes
y comprueba SQL, sqlite-vec y sharp antes de dar el proceso por concluido con éxito.
Usa `npm run native:check` para hacer una comprobación sin instalar nada.
Consulta el [script de verificación de dependencias nativas](./scripts/verify-native-dependencies.cjs) para ver qué comprobaciones se realizan.

---

## Cómo funciona

### Enrutamiento de tareas

El Commander se encarga él mismo del trabajo general y delega el trabajo especializado mediante tres herramientas:

- **`dispatch_to`** ejecuta un agente con nombre y devuelve su resultado para seguir trabajando. Puede esperar al resultado o ejecutarse de forma asíncrona y avisar al Commander cuando la tarea termine.
- **`hand_off_to`** traspasa el trabajo restante a un agente con nombre y termina el turno actual del Commander. El agente entrega su propia respuesta; una continuación opcional permite al Commander retomar después una tarea más amplia.
- **`run_worker`** ejecuta una subtarea anónima y aislada y devuelve un resultado privado. No recibe el historial de la conversación ni las habilidades de un agente con nombre.

Las tareas de agentes con nombre y los workers anónimos tienen controles de concurrencia independientes. Consulta la [implementación del despacho](./src/main/features/group_chat/bus.ts) y los [bloqueos de ejecución](./src/main/util/locks.ts).

### Gestión del contexto

El entorno de ejecución reparte el presupuesto de contexto según la capacidad de entrada útil del modelo seleccionado, teniendo en cuenta los prompts, las herramientas y el estado persistente del entorno de ejecución. Los diálogos ya terminados usan una ventana acotada de historial reciente; las tareas activas largas usan puntos de control para condensar los mensajes anteriores del proceso sin perder el trabajo reciente. Las lecturas de archivos, los cambios en archivos y las ejecuciones de comandos también tienen registros estructurados que pueden sobrevivir a la compactación del contexto.

Consulta [presupuestos de contexto](./src/core-agent/src/agent/context-budget.ts), [historial de sesión y puntos de control](./src/core-agent/src/agent/session.ts) y [registros del espacio de trabajo](./src/core-agent/src/agent/workspace-state.ts).

### La memoria y la Biblioteca

Las notas persistentes guardan las preferencias del usuario, los datos del proyecto y el conocimiento reutilizable de cada agente en ámbitos separados. Estas notas son distintas del índice de documentos de la Biblioteca y del historial de conversaciones guardado.

La Biblioteca divide los documentos en fragmentos y guarda un índice vectorial local en SQLite. Su modelo de embeddings se ejecuta en tu equipo; la herramienta `library` puede listar archivos, buscar fragmentos relevantes y leer el contenido original de la Biblioteca global o de la del proyecto actual. Las conversaciones anteriores se recuperan por separado mediante `chat_history`.

Consulta [memoria por ámbitos](./src/main/features/memory.ts), [extracción de documentos](./src/main/util/file_to_chunks.ts), [herramientas de la Biblioteca](./src/main/model/core-agent/kb-tools.ts) y [recuperación de conversaciones](./src/main/model/core-agent/chat-history-tools.ts).

### Límites de ejecución y recuperación

Los bloqueos de sesión y los límites de concurrencia acotan el trabajo en paralelo. Los presupuestos de rondas de herramientas, los puntos de control de progreso, las comprobaciones de llamadas repetidas y los watchdogs de inactividad que tienen en cuenta cada fase ayudan a contener las ejecuciones que se atascan o repiten trabajo. Las tareas de agentes con nombre se pueden seguir y cancelar de forma individual; una tarea admitida o en cola no se considera un resultado completado.

Consulta [presupuestos de actores](./src/main/features/group_chat/actor-budgets.ts), el [entorno de ejecución de agentes](./src/core-agent/src/agent/runner.ts) y el [adaptador de modelos de la aplicación de escritorio](./src/main/model/core-agent/client.ts).

### Aprendizaje a partir de la actividad

Las revisiones en segundo plano examinan la actividad nueva de los agentes cuando la aplicación está inactiva, sujetas a periodos de espera y a límites de ejecución. Una revisión puede actualizar la autoevaluación de un agente (`COMPETENCE.md`), sus métodos reutilizables (`LEARNING_STRATEGIES.md`) o sus habilidades aprendidas. Las revisiones dependen de que haya actividad nueva, no del número de tareas, y pueden concluir que no hay nada que merezca la pena guardar.

Consulta el [planificador de reflexión](./src/main/features/reflection-orchestrator.ts) y el [prompt de revisión](./src/core-agent/src/evolution/metacognition.ts).

---

## Preguntas frecuentes

**¿Qué es Orkas?**
Orkas es una aplicación de escritorio multiagente, de código abierto (MIT) y con prioridad local. Su Commander convierte tu objetivo en pendientes y coordina 16 agentes especializados integrados, además de Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent, para entregar archivos terminados. No es un único chatbot, ni un framework de código, ni un SaaS alojado.

**¿Necesito una clave de API?**
No. La aplicación instalable incluye 500 créditos para el modelo integrado de Orkas. Después, puedes comprar créditos, elegir un plan de pago o añadir las claves de tu propio proveedor; los cargos del proveedor se pagan aparte.

**¿Orkas es un LLM local?**
No. Orkas se ejecuta en tu equipo y llama a los modelos que elijas: el modelo integrado de Orkas, tus propias claves de API o un endpoint de modelo local. Orquesta agentes y herramientas; no es un modelo en sí.

**¿Puede Orkas responder a preguntas sobre mis documentos, con citas?**
Sí. Añade PDF y otros documentos a tu Biblioteca local; Orkas puede buscar en ellos y responder con citas de los fragmentos de origen, para que puedas abrir el original y comprobarlo. El índice se crea en tu equipo.

**¿Puedo usar modelos locales como Ollama o LM Studio?**
Sí. Abre **Configuración de la cuenta → Modelos → Chat → Añadir modelo → Personalizado**, selecciona **Compatible con OpenAI** o **Compatible con Anthropic** e introduce la URL base, el ID exacto del modelo y la clave de API. Elige el modelo guardado en el selector de modelo de la tarea.

**¿Dónde se guardan mis claves de API y mis datos?**
En tu disco, de forma predeterminada. Las claves de tu propio proveedor se cifran localmente y quedan excluidas de la sincronización en la nube. Con tus propias claves, las llamadas al modelo van directamente de tu equipo al proveedor; el modelo integrado de Orkas usa el servicio gestionado de Orkas. La sincronización en la nube opcional y los proyectos compartidos de la aplicación instalable guardan los datos seleccionados en los servidores de Orkas. [Seguridad y tratamiento de datos →](https://orkas.ai/security/?source=gh-orkas)

**¿Orkas funciona sin conexión?**
La versión de código fuente puede funcionar totalmente sin conexión con un endpoint de modelo local. La aplicación instalable necesita iniciar sesión, y los modelos en la nube necesitan conexión a la red.

**¿Sigue funcionando con el ordenador apagado?**
No. Orkas se ejecuta en tu ordenador, así que el Avance automático y las automatizaciones necesitan que el ordenador esté encendido y activo, y Orkas en ejecución. Desde la v1.9, cuando el ordenador se reactiva o se inicia Orkas, cada automatización recupera su ejecución perdida más reciente de las 12 horas anteriores.

**¿Puedo crear y publicar aplicaciones?**
Sí. Las aplicaciones locales que se ejecutan dentro de Orkas son gratuitas. Para publicar una aplicación web con un enlace público se necesita un plan de pago (Lite: 5 aplicaciones; Pro: 8; Max: 15), y las aplicaciones web publicadas no incluyen todas las funciones disponibles dentro de Orkas.

**¿Necesito una cuenta de Orkas?**
La aplicación de escritorio instalable te pide iniciar sesión la primera vez que la abres. La versión de código fuente de este repositorio no tiene ninguna capa de cuentas: arranca directamente en la aplicación.

**¿Puede Orkas controlar Claude Code y otros agentes de CLI?**
Sí. Orkas puede controlar cinco agentes de CLI externos como subprocesos locales (los agentes de programación Claude Code, Codex y OpenCode, y los agentes personales OpenClaw y Hermes-Agent) e incorporar proyectos de código abierto como HyperFrames, todo ello dirigido desde el mismo chat.

**¿En qué se diferencia Orkas de Claude Code / Codex / CrewAI / LangChain?**
Claude Code y Codex son agentes de programación, y Orkas ejecuta ambos como miembros de su equipo, así que no tienes que elegir entre ellos; CrewAI y LangChain son frameworks centrados en el código. Orkas es una aplicación de escritorio de código abierto en la que un Commander coordina un equipo de agentes especializados y tus agentes de CLI, con cualquier proveedor de modelos, y mantiene los datos y las claves en local. Consulta las [comparativas completas](https://orkas.ai/compare/?source=gh-orkas).

**¿Qué plataformas admite Orkas?**
macOS 12+ (Apple Silicon e Intel) y Windows 10+ tienen instaladores. Linux x64/arm64 con glibc 2.34+ funciona hoy desde el código fuente, todavía sin instalador. La transcripción de voz local es compatible con Linux mediante el entorno de ejecución de whisper.cpp con versión fijada, que se prepara en el primer arranque. Alpine y otras distribuciones basadas en musl no son compatibles. El arranque desde el código fuente necesita Node 22.12+; Python 3 y una cadena de herramientas de compilación de C/C++ solo hacen falta cuando un paquete nativo de npm no tiene un binario precompilado compatible y hay que recompilarlo en local.

**¿Orkas es gratuito y de código abierto?**
Sí. La aplicación tiene licencia MIT y es de uso gratuito. La aplicación instalable incluye 500 créditos para el modelo integrado de Orkas; los planes de pago, desde $11.99/mes, añaden créditos mensuales, sincronización en la nube, más proyectos compartidos y publicación de aplicaciones. Con tus propias claves, el uso del modelo lo factura tu proveedor; Orkas no añade ningún recargo. [Precios →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licencia

[MIT](./LICENSE)
