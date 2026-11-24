# Orkas

**Un equipo de agentes de IA de código abierto en tu escritorio: convierte tus metas en trabajo terminado y hace que siga avanzando.**

Orkas es una aplicación de escritorio multiagente, de código abierto (MIT) y con prioridad local: un asistente de IA que trabaja como un equipo. Dile al **Commander** lo que necesitas: completa muchas tareas por su cuenta y, para trabajos más grandes, planea los pasos y suma agentes especializados, junto con los agentes de programación y personales que ya usas (**Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent**), para que trabajen juntos en ello.

Orkas está diseñado para que un proyecto siga avanzando, no solo para responder una única solicitud. Un **proyecto** reúne la meta, las reglas, la memoria y los archivos, así que cada conversación nueva retoma el trabajo donde quedó la anterior. La lista de **Pendientes** reparte el trabajo entre personas y agentes, el **Avance automático** permite que el equipo tome por sí solo el siguiente pendiente y las **automatizaciones programadas** repiten el trabajo de rutina cada hora, cada día, cada semana o cada mes. Todos tus datos se quedan en tu computadora y el trabajo terminado vuelve a ti para que lo revises; así puedes confiarle a Orkas el trabajo continuo de tu negocio.

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

![Orkas en la computadora: conversación de una tarea y entregables](./resources/app-ui/task-en.png)

---

## Lo que entrega el equipo

- **Videos, voces en off e imágenes** — [VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio), VoiceStudio, ImageStudio
- **Reportes de investigación, auditorías SEO y análisis de mercado** — DeepResearcher, SeoGeoAgent, StockAnalyser
- **Publicaciones, artículos, newsletters y presentaciones** — ContentWriter, PptMaker
- **Sitios web, interfaces y código** — UIDesigner, ProductDeveloper
- **Archivos de Word, Excel, PowerPoint y PDF** — OfficeWorker
- **Tareas de e-commerce** — investigación de productos, publicaciones, análisis de reseñas, análisis de ventas y cambios en el catálogo, a cargo de cinco agentes de e-commerce
- **Trabajos complejos que requieren varios agentes** — el Commander los divide, asigna cada parte al agente indicado y combina los resultados; por ejemplo, un estudio de mercado que se convierte en un reporte, una presentación y un video de lanzamiento

La app incluye 16 especialistas, cada uno con sus propias habilidades, memoria y herramientas. Explora más de 30 agentes en el [marketplace de agentes](https://orkas.ai/views/marketplace/gs/agents/?source=gh-orkas) o describe el rol que necesitas y el Commander creará un agente personalizado para ti.

<details>
<summary><b>Los 16 agentes integrados</b></summary>

| Área | Agente | Qué entrega |
| --- | --- | --- |
| Investigación y análisis | **DeepResearcher** | Investigación basada en evidencia, con fuentes verificadas, contradicciones señaladas y un reporte auditable |
| | **SeoGeoAgent** | Dale una URL: auditoría técnica, calidad del contenido, Core Web Vitals, probabilidad de ser citado en respuestas de IA (GEO) y lista priorizada de correcciones |
| | **StockAnalyser** | Análisis de acciones, filtros por factores, backtests y verificación de riesgos del portafolio, con tableros trazables |
| Contenido y medios | **ContentWriter** | Publicaciones, artículos, newsletters y casos de estudio listos para publicar a partir de una meta, de fuentes o de un borrador |
| | **PptMaker** | Presentaciones PPTX editables y fáciles de revisar a partir de un tema, un esquema o un documento |
| | **ImageStudio** | Pósters, portadas, imágenes para redes sociales e infografías |
| | **[VideoStudio](https://github.com/Orkas-AI/Orkas-VideoStudio)** | Narración, presentadores con IA, subtítulos y doblaje, clips de los mejores momentos, localización y recreación de videos de referencia con tu propio contenido y tus propias grabaciones |
| | **VoiceStudio** | Narración, audio con varias voces, transcripciones y subtítulos, edición y mezcla de audio |
| | **UIDesigner** | Interfaces editables basadas en HTML a partir de metas de producto, PRD, capturas de pantalla o material de Figma |
| Desarrollo y oficina | **ProductDeveloper** | Ingeniería que entiende tu repositorio: implementa un PRD, corrige bugs, refactoriza y revisa, con resultados verificables |
| | **OfficeWorker** | Crea, edita, revisa y entrega archivos Word / Excel / PowerPoint / PDF, uno por uno o por lotes |
| E-commerce | **ECommerceResearcher** | Selección de productos según presupuesto, mercado y restricciones de abastecimiento: candidatos, motivos de descarte y planes de validación |
| | **ECommerceWriter** | Títulos, páginas de detalle, preguntas frecuentes, textos para imágenes y guiones de video con la voz de tu marca |
| | **ECommerceReviewer** | Análisis de reseñas y reputación: temas recurrentes de los clientes, causas raíz de las malas reseñas y prioridades |
| | **ECommerceAnalyzer** | Ventas, ganancias, anuncios, reembolsos e inventario a partir de tus exportaciones: métricas conciliadas y decisiones |
| | **ECommerceOperator** | Planea cambios de catálogo, precios, promociones e inventario; solo los ejecuta a través de las herramientas que conectes |

Más información sobre cada agente → [orkas.ai/agents](https://orkas.ai/agents/?source=gh-orkas)

</details>

### Recrea un video de referencia con tu propio contenido

**VideoStudio** puede recrear la estructura narrativa, el estilo visual y el ritmo de edición de un video viral usando tu propio producto, guion y grabaciones. Proporciona un archivo de video de referencia y tus recursos: el agente analiza el gancho, el orden de la información, los momentos visuales clave y el llamado a la acción, y antes de la producción propone qué conservar y qué reemplazar.

Funciona mejor para videos explicativos con motion graphics, demos de SaaS o de apps y anuncios de producto hechos con las grabaciones que ya tienes. Los textos, subtítulos, narraciones y clips creados localmente se pueden revisar por separado; el texto incrustado en un video generado con IA solo se puede cambiar modificando ese video.

> “Usa reference.mp4 como referencia para un video promocional vertical de 30 segundos. Conserva su gancho, su tipografía y su ritmo, reemplaza el contenido con mi producto y mis grabaciones de pantalla, y muéstrame primero el desglose y el plan.”

Empieza con un archivo de video que el agente pueda leer; la descarga desde enlaces compartidos de redes sociales no viene incluida. No se garantiza replicar con exactitud los movimientos de cámara ni las actuaciones de personas, ni una coincidencia cuadro por cuadro. Consulta el [flujo de trabajo para recrear videos de referencia](./resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-craft/references/reference-recreation.md).

---

## Mantén el trabajo en marcha

Una tarea es un buen comienzo. Orkas está hecho para el trabajo que continúa.

- **Proyectos** — metas y reglas, memoria y archivos de los que parte cada conversación del proyecto, para que nunca tengas que explicar todo desde cero.
- **Pendientes y Avance automático** — cada proyecto tiene una lista de pendientes para personas y agentes; con el Avance automático activado, el equipo toma por sí solo el siguiente elemento y te devuelve el trabajo terminado para que lo revises.
- **Automatizaciones programadas** — ejecuta cualquier tarea cada hora, cada día, cada semana o cada mes. Orkas se ejecuta en tu computadora. Desde la v1.9, cuando la computadora se reactiva o Orkas se inicia, cada automatización recupera su ejecución perdida más reciente de las últimas 12 horas.
- **Conectores** — Gmail, Google Calendar, Sheets y Drive, Notion, Slack, Shopify, Stripe y muchos más. De manera predeterminada, Orkas te pide confirmación antes de enviar, publicar o borrar cualquier cosa.
- **Aplicaciones** — describe una herramienta y Orkas la crea como app local dentro de la aplicación de escritorio. En la app instalable, los planes de pago también pueden publicarla como app web con un enlace público.
- **Proyectos compartidos** *(app instalable)* — invita a un compañero de equipo o a un asistente virtual, y asigna cada pendiente a una persona o a un agente.

> [!NOTE]
> Los proyectos compartidos, la sincronización en la nube y la publicación de apps web solo están disponibles en la app instalable; la versión de código abierto aún no los admite. Para usarlos, **[descarga Orkas para macOS y Windows](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** (gratis, con 500 créditos para empezar).

La entrada de voz también funciona en la versión de código fuente. Configura una **Orkas API Key** en **Configuración → Modelos** y haz clic en el micrófono junto al cuadro de texto. Cuando se te pida, permite el acceso al micrófono. El audio se envía a Orkas para su reconocimiento y consume los créditos de Orkas del titular de la clave. Vuelve a hacer clic para detener la grabación, revisa el texto y envíalo tú mismo. Si denegaste el acceso, activa el micrófono en la configuración del sistema.

---

## Ejecuta Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent en conjunto

Orkas ejecuta como sesiones locales los agentes de CLI que ya tienes instalados, junto a sus propios especialistas: los agentes de programación **Claude Code, Codex y OpenCode**, y los agentes personales **OpenClaw y Hermes-Agent**. El Commander le asigna a cada uno la parte en la que mejor se desempeña y mantiene un solo plan para todos, así que en un mismo chat se puede corregir el bug, revisar el cambio y redactar la nota de versión. Las herramientas de código abierto como HyperFrames se conectan de la misma manera.

[Cómo usar Claude Code y Codex en conjunto →](https://orkas.ai/blog/claude-code-codex-together/?source=gh-orkas)

---

## Por qué Orkas

- **Un Commander que planea, delega y hace el resto** — divide las metas, elige los agentes, las habilidades, los conectores y las herramientas adecuados, y se encarga él mismo del análisis, la redacción, la investigación y el trabajo con archivos cuando ningún especialista es más indicado.
- **Con prioridad local desde el diseño** — las conversaciones, los archivos, las bases de conocimiento y los agentes personalizados se quedan en tu disco de manera predeterminada. La sincronización en la nube es opcional en la app instalable. Con tus propias claves, las llamadas al modelo van directamente de tu computadora al proveedor; el modelo integrado de Orkas funciona a través del servicio de modelos administrado por Orkas.
- **Cualquier modelo, cámbialo cuando quieras** — el Commander y los agentes integrados comparten una misma configuración de modelo: el modelo integrado de Orkas, tu propio proveedor o un endpoint local. Los agentes de CLI externos mantienen su propia configuración de modelo.
- **Agentes que van mejorando** — cada agente conserva habilidades y memoria privadas. Las revisiones en segundo plano analizan la actividad nueva cuando la app está inactiva y pueden refinar la autoevaluación, los métodos reutilizables y las habilidades aprendidas.
- **Código abierto, sin cajas negras** — licencia MIT. Puedes ver exactamente qué hacen Orkas, cada agente y cada habilidad.

> ⭐ Si Orkas te resulta útil, una estrella ayuda a que más personas encuentren el proyecto.

---

## Descarga

| | App instalable (recomendada) | Ejecutar desde el código fuente |
| --- | --- | --- |
| Plataformas | macOS 12+ (Apple Silicon e Intel), Windows 10+ | macOS, Windows, Linux x64/arm64 con glibc 2.34+ |
| Cuenta | Inicio de sesión: 500 créditos gratis | No se requiere |
| Modelos | Modelo integrado de Orkas o tus propias claves | Tus propias claves o un endpoint local |
| También incluye | Colaboración en proyectos, publicación de apps, sincronización en la nube y más | — |
| Cómo obtenerla | **[Descargar Orkas](https://orkas.ai/download/?source=gh-orkas&entry_point=github_readme&download=1)** | [Inicio rápido](#inicio-rápido) |

El enlace de descarga detecta tu sistema e inicia el instalador correcto.

---

## Para qué lo usa la gente

- **Contenido de marketing** — videos de lanzamiento, páginas de producto, publicaciones y newsletters con tu propio estilo. [Redacción de contenido](https://orkas.ai/use/content-writing/?source=gh-orkas) · [Videos](https://orkas.ai/use/make-videos/?source=gh-orkas)
- **Operación de tiendas** — reportes semanales de ventas, respuestas a reseñas, publicaciones y monitoreo de la competencia. [E-commerce](https://orkas.ai/use/ecommerce/?source=gh-orkas)
- **Investigación y reportes** — reportes y presentaciones con fuentes, cuando los necesites o cada semana. [Investigación](https://orkas.ai/use/researchers/?source=gh-orkas) · [Análisis de datos](https://orkas.ai/use/data-analysis/?source=gh-orkas)
- **Chatea con tus documentos** — respuestas basadas en tus propios archivos, con citas que remiten a los fragmentos originales. [Chatear con documentos](https://orkas.ai/use/chat-with-documents/?source=gh-orkas)
- **Trabajo con clientes** — resúmenes para reuniones, reportes mensuales para clientes y presentaciones de avance con tu plantilla. [Plantilla de reporte mensual para clientes](https://orkas.ai/blog/monthly-client-report-template/?source=gh-orkas)
- **Lanzamiento de productos** — páginas de aterrizaje, corrección de bugs con pruebas, registros de cambios y publicaciones de lanzamiento. [Desarrolladores](https://orkas.ai/use/developers/?source=gh-orkas)
- **Crea una app** — calculadoras de cotizaciones, formularios de reserva, herramientas internas. [Crear apps](https://orkas.ai/use/build-apps/?source=gh-orkas)
- **Equipos pequeños** — un solo proyecto para personas y agentes. [Equipos pequeños](https://orkas.ai/use/small-teams/?source=gh-orkas)

---

## Cómo se compara Orkas

| Herramienta | Qué es | En qué se diferencia Orkas |
| --- | --- | --- |
| **Claude Code** | La herramienta de programación agéntica de Anthropic, disponible en la terminal, el IDE, el escritorio y la web, basada en los modelos Claude. | No tienes que elegir: Orkas ejecuta Claude Code como uno de sus agentes. A su alrededor, Orkas agrega un equipo independiente del modelo para el trabajo que va más allá del código (investigación, contenido, video y más), con proyectos, pendientes y automatizaciones que lo mantienen en marcha. [Orkas vs. Claude Code →](https://orkas.ai/compare/orkas-vs-claude-code/?source=gh-orkas) |
| **Codex** | El agente de programación de OpenAI, disponible en la terminal, en tu editor y en la nube. | No tienes que elegir: Orkas ejecuta Codex como uno de sus agentes, junto a Claude Code y OpenCode. El Commander puede encargarle la programación a Codex y la revisión a otro agente, y luego cubrir la otra mitad de un lanzamiento, la que no es código: documentación, publicaciones de lanzamiento y videos. [Orkas vs. Codex →](https://orkas.ai/compare/orkas-vs-codex/?source=gh-orkas) |
| **Claude Cowork** | El agente de Anthropic para el trabajo diario, ahora parte de Claude: disponible en escritorio, web y celular con un plan de pago de Claude. De manera predeterminada se ejecuta en la nube de Anthropic y usa modelos Claude. | Una alternativa de código abierto (MIT) a Claude Cowork que puedes empezar a usar gratis, con 500 créditos. Orkas ejecuta sus agentes en tu computadora y, de manera predeterminada, conserva tus datos localmente, con el modelo integrado de Orkas, las claves de tu propio proveedor o un endpoint local. El Commander también puede sumar a Claude Code, Codex y otros agentes de CLI. La contrapartida: Orkas necesita que tu computadora esté encendida y activa, mientras que las tareas en la nube de Cowork pueden seguir ejecutándose sin ella. [Alternativas a Claude Cowork →](https://orkas.ai/compare/claude-cowork-alternatives/?source=gh-orkas) |
| **Manus** | Un agente de IA que, de manera predeterminada, planea y ejecuta tareas en la nube de Manus. La app de escritorio Manus Studio (macOS y Windows) también puede trabajar en una carpeta que elijas, aunque las tareas se siguen planeando en la nube. | Una alternativa de código abierto (MIT) a Manus. Orkas ejecuta sus agentes en tu computadora y, de manera predeterminada, conserva tus datos localmente, con el modelo integrado de Orkas, las claves de tu propio proveedor o un endpoint local. Los proyectos, los pendientes y las automatizaciones mantienen el trabajo en marcha. La contrapartida: Orkas necesita que tu computadora esté encendida y activa, mientras que las tareas en la nube de Manus pueden seguir ejecutándose sin ella. [Alternativa de código abierto a Manus →](https://orkas.ai/open-source-manus-alternative/?source=gh-orkas) |
| **LangChain** | Un framework/biblioteca para desarrolladores que sirve para crear apps y agentes basados en LLM; está centrado en el código y se integra en tu propia app de Python/JS. | Orkas es una aplicación de escritorio que diriges por chat, sin escribir código de orquestación. Los datos se guardan localmente de manera predeterminada. |
| **CrewAI** | Un framework de Python para orquestar agentes autónomos que asumen roles; los equipos (crews) y los agentes se definen en código. | Orkas lleva la orquestación multiagente a una aplicación de escritorio, con proyectos, pendientes, automatizaciones y automejora por agente ya integrados. |
| **OpenClaw** | Una plataforma de agentes personales con integraciones de mensajería, enrutamiento multiagente y subagentes. | Orkas ofrece un espacio de trabajo de escritorio orientado a entregables terminados, con especialistas integrados y coordinación entre Claude Code, Codex, OpenCode y otros agentes de CLI. OpenClaw puede sumarse a ese flujo de trabajo como agente de CLI. |
| **Hermes-Agent** | El agente de Nous Research que se mejora a sí mismo: un solo agente con memoria y habilidades, disponible como CLI, como pasarela de mensajería y como app de escritorio. | Orkas coordina un equipo: el Commander dirige a muchos especialistas y a otros agentes de CLI, y Hermes-Agent se suma como uno de ellos. |

**Orkas es para ti si** quieres un equipo de agentes en vez de un solo asistente, un trabajo que siga avanzando a lo largo de varios días, y tus datos, claves y agentes en tu propio disco.

**No es para ti si** solo quieres un chatbot que sirva para todo o una biblioteca de código pura para integrar en tu propia app.

**¿Estás eligiendo entre agentes de programación?** [Codex vs. OpenCode](https://orkas.ai/compare/codex-vs-opencode/?source=gh-orkas) · [Claude Code vs. Codex vs. OpenCode](https://orkas.ai/compare/claude-code-vs-codex-vs-opencode/?source=gh-orkas) · [Alternativas a Claude Code](https://orkas.ai/compare/claude-code-alternatives/?source=gh-orkas)

**Comparaciones completas lado a lado →** [vs. Claude Code](https://orkas.ai/compare/orkas-vs-claude-code?source=gh-orkas) · [vs. Codex](https://orkas.ai/compare/orkas-vs-codex?source=gh-orkas) · [vs. Cline](https://orkas.ai/compare/orkas-vs-cline?source=gh-orkas) · [vs. LangChain](https://orkas.ai/compare/orkas-vs-langchain?source=gh-orkas) · [vs. ChatGPT](https://orkas.ai/compare/orkas-vs-chatgpt?source=gh-orkas) · [vs. OpenClaw](https://orkas.ai/compare/orkas-vs-openclaw?source=gh-orkas) · [vs. Hermes-Agent](https://orkas.ai/compare/orkas-vs-hermes-agent?source=gh-orkas)

---

## Inicio rápido

¿Prefieres un instalador listo para usar? Consulta [Descarga](#descarga) más arriba. Para ejecutar Orkas desde el código fuente, que por ahora es la forma de usarlo en Linux:

**Requisitos**: Node 22.12+ · macOS / Windows 10+ / Linux x64 o arm64 con glibc 2.34+. Ten disponibles Python 3 y una cadena de herramientas de compilación de C/C++ para el caso poco común en que haya que compilar módulos nativos desde el código fuente.

```bash
git clone https://github.com/Orkas-AI/Orkas.git
cd Orkas
./run.sh           # macOS / Linux
run.cmd            # Windows
```

En Linux, la ejecución desde el código fuente requiere glibc 2.34+. Alpine y otras distribuciones basadas en musl no son compatibles. Durante el primer inicio desde el código fuente, la transcripción de voz local descarga y verifica el entorno de ejecución de whisper.cpp nativo de la plataforma de destino y el modelo multilingüe.

`run.sh` / `run.cmd` instala el árbol de dependencias de npm con versiones bloqueadas y, en el primer inicio, prepara las versiones fijadas de Python, uv, Node, el modelo de embeddings (~95 MB), OfficeCLI, FFmpeg, whisper.cpp y los recursos del modelo de voz multilingüe. Luego, en Linux, el inicio verifica los módulos nativos de la plataforma y el entorno de ejecución de Whisper con la ABI de Electron antes de abrir la app. Los paquetes de Python para OCR y los específicos de cada habilidad se instalan en entornos locales aislados la primera vez que se usan esas funciones. El primer inicio crea un espacio de trabajo en `~/.orkas/` (macOS / Linux) o en `<smallest non-system drive>:\.orkas\` (Windows). Después, abre **Configuración → Proveedores de IA** para agregar una clave de API u OAuth.

Errores de dependencias nativas: usa Node.js 24 LTS (mínimo 22.12.0) y luego ejecuta
`npm run native:repair` desde esta copia del repositorio. Esto restaura los paquetes opcionales,
repara SQLite para Electron, prepara el Node incluido para el procesamiento aislado de imágenes
y verifica SQL, sqlite-vec y sharp antes de reportar que todo salió bien.
Usa `npm run native:check` para hacer una verificación sin instalar nada.
Consulta el [script de verificación de dependencias nativas](./scripts/verify-native-dependencies.cjs) para conocer las revisiones que realiza.

---

## Cómo funciona

### Enrutamiento de tareas

El Commander se encarga él mismo del trabajo general y delega el trabajo especializado mediante tres herramientas:

- **`dispatch_to`** ejecuta un agente con nombre y devuelve su resultado para continuar el trabajo. Puede esperar el resultado o ejecutarse de forma asíncrona y avisarle al Commander cuando la tarea termine.
- **`hand_off_to`** transfiere el trabajo restante a un agente con nombre y finaliza el turno actual del Commander. El agente entrega su propia respuesta; una continuación opcional le permite al Commander retomar después una tarea más amplia.
- **`run_worker`** ejecuta una subtarea anónima y aislada y devuelve un resultado privado. No recibe el historial de la conversación ni las habilidades de un agente con nombre.

Las tareas de agentes con nombre y los workers anónimos tienen controles de concurrencia separados. Consulta la [implementación del despacho](./src/main/features/group_chat/bus.ts) y los [bloqueos de ejecución](./src/main/util/locks.ts).

### Manejo del contexto

El entorno de ejecución asigna el presupuesto de contexto según la capacidad de entrada utilizable del modelo seleccionado, considerando los prompts, las herramientas y el estado persistente del entorno de ejecución. Los diálogos ya terminados usan una ventana limitada de historial reciente; las tareas activas largas usan puntos de control para condensar los mensajes anteriores del proceso sin perder el trabajo reciente. Las lecturas de archivos, los cambios en archivos y las ejecuciones de comandos también tienen registros estructurados que pueden sobrevivir a la compactación del contexto.

Consulta [presupuestos de contexto](./src/core-agent/src/agent/context-budget.ts), [historial de sesión y puntos de control](./src/core-agent/src/agent/session.ts) y [registros del espacio de trabajo](./src/core-agent/src/agent/workspace-state.ts).

### La memoria y la Biblioteca

Las notas persistentes guardan las preferencias del usuario, los datos del proyecto y el conocimiento reutilizable de cada agente en ámbitos separados. Estas notas son distintas del índice de documentos de la Biblioteca y del historial de conversaciones almacenado.

La Biblioteca divide los documentos en fragmentos y almacena un índice vectorial local en SQLite. Su modelo de embeddings se ejecuta en tu computadora; la herramienta `library` puede listar archivos, buscar fragmentos relevantes y leer el contenido original de la Biblioteca global o de la del proyecto actual. Las conversaciones anteriores se recuperan por separado a través de `chat_history`.

Consulta [memoria por ámbitos](./src/main/features/memory.ts), [extracción de documentos](./src/main/util/file_to_chunks.ts), [herramientas de la Biblioteca](./src/main/model/core-agent/kb-tools.ts) y [recuperación de conversaciones](./src/main/model/core-agent/chat-history-tools.ts).

### Límites de ejecución y recuperación

Los bloqueos de sesión y los límites de concurrencia acotan el trabajo en paralelo. Los presupuestos de rondas de herramientas, los puntos de control de progreso, las verificaciones de llamadas repetidas y los watchdogs de inactividad que consideran la fase de cada ejecución ayudan a contener las ejecuciones que se traban o repiten trabajo. Las tareas de agentes con nombre se pueden rastrear y cancelar individualmente; una tarea admitida o en cola no se considera un resultado completado.

Consulta [presupuestos de actores](./src/main/features/group_chat/actor-budgets.ts), el [entorno de ejecución de agentes](./src/core-agent/src/agent/runner.ts) y el [adaptador de modelos de la app de escritorio](./src/main/model/core-agent/client.ts).

### Aprendizaje a partir de la actividad

Las revisiones en segundo plano analizan la actividad nueva de los agentes cuando la app está inactiva, sujetas a períodos de espera y límites de ejecución. Una revisión puede actualizar la autoevaluación de un agente (`COMPETENCE.md`), sus métodos reutilizables (`LEARNING_STRATEGIES.md`) o sus habilidades aprendidas. Las revisiones dependen de que haya actividad nueva, no de la cantidad de tareas, y pueden concluir que no hay nada que valga la pena guardar.

Consulta el [planificador de reflexión](./src/main/features/reflection-orchestrator.ts) y el [prompt de revisión](./src/core-agent/src/evolution/metacognition.ts).

---

## Preguntas frecuentes

**¿Qué es Orkas?**
Orkas es una aplicación de escritorio multiagente, de código abierto (MIT) y con prioridad local. Su Commander convierte tu meta en pendientes y coordina 16 agentes especialistas integrados, además de Claude Code, Codex, OpenCode, OpenClaw y Hermes-Agent, para entregar archivos terminados. No es un único chatbot, ni un framework de código, ni un SaaS alojado.

**¿Necesito una clave de API?**
No. La app instalable incluye 500 créditos para el modelo integrado de Orkas. Después, puedes comprar créditos, elegir un plan de pago o agregar las claves de tu propio proveedor; los cobros del proveedor son aparte.

**¿Orkas es un LLM local?**
No. Orkas se ejecuta en tu computadora y llama a los modelos que elijas: el modelo integrado de Orkas, tus propias claves de API o un endpoint de modelo local. Orquesta agentes y herramientas; no es un modelo en sí mismo.

**¿Orkas puede responder preguntas a partir de mis documentos, con citas?**
Sí. Agrega PDF y otros documentos a tu Biblioteca local; Orkas puede buscar en ellos y responder con citas de los fragmentos originales, para que puedas abrir el documento original y verificarlo. El índice se crea en tu computadora.

**¿Puedo usar modelos locales como Ollama o LM Studio?**
Sí. Abre **Configuración de la cuenta → Modelos → Chat → Añadir modelo → Personalizado**, selecciona **Compatible con OpenAI** o **Compatible con Anthropic** e ingresa la URL base, el ID exacto del modelo y la clave de API. Elige el modelo guardado en el selector de modelo de la tarea.

**¿Dónde se guardan mis claves de API y mis datos?**
En tu disco, de manera predeterminada. Las claves de tu propio proveedor se cifran localmente y se excluyen de la sincronización en la nube. Con tus propias claves, las llamadas al modelo van directamente de tu computadora al proveedor; el modelo integrado de Orkas usa el servicio administrado de Orkas. La sincronización en la nube opcional y los proyectos compartidos de la app instalable almacenan los datos seleccionados en los servidores de Orkas. [Seguridad y manejo de datos →](https://orkas.ai/security/?source=gh-orkas)

**¿Orkas funciona sin conexión?**
La versión de código fuente puede funcionar completamente sin conexión con un endpoint de modelo local. La app instalable necesita iniciar sesión, y los modelos en la nube requieren conexión a la red.

**¿Sigue funcionando cuando mi computadora está apagada?**
No. Orkas se ejecuta en tu computadora, así que el Avance automático y las automatizaciones necesitan que la computadora esté encendida y activa, y que Orkas esté abierto. Desde la v1.9, cuando la computadora se reactiva o Orkas se inicia, cada automatización recupera su ejecución perdida más reciente de las últimas 12 horas.

**¿Puedo crear y publicar apps?**
Sí. Las apps locales que se ejecutan dentro de Orkas son gratuitas. Para publicar una app web con un enlace público necesitas un plan de pago (Lite: 5 apps; Pro: 8; Max: 15), y las apps web publicadas no incluyen todas las capacidades disponibles dentro de Orkas.

**¿Necesito una cuenta de Orkas?**
La app de escritorio instalable te pide iniciar sesión la primera vez que la abres. La versión de código fuente de este repositorio no tiene ninguna capa de cuentas: arranca directamente en la app.

**¿Orkas puede controlar Claude Code y otros agentes de CLI?**
Sí. Orkas puede controlar cinco agentes de CLI externos como subprocesos locales (los agentes de programación Claude Code, Codex y OpenCode, además de los agentes personales OpenClaw y Hermes-Agent) e incorporar proyectos de código abierto como HyperFrames, todo dirigido desde el mismo chat.

**¿En qué se diferencia Orkas de Claude Code / Codex / CrewAI / LangChain?**
Claude Code y Codex son agentes de programación: Orkas ejecuta ambos como miembros de su equipo, así que no tienes que elegir entre ellos; CrewAI y LangChain son frameworks centrados en el código. Orkas es una aplicación de escritorio de código abierto en la que un Commander coordina un equipo de agentes especialistas y tus agentes de CLI, con cualquier proveedor de modelos, y conserva localmente los datos y las claves. Consulta las [comparaciones completas](https://orkas.ai/compare/?source=gh-orkas).

**¿Qué plataformas son compatibles con Orkas?**
macOS 12+ (Apple Silicon e Intel) y Windows 10+ cuentan con instaladores. Linux x64/arm64 con glibc 2.34+ funciona hoy desde el código fuente, todavía sin instalador. La transcripción de voz local es compatible con Linux mediante el entorno de ejecución de whisper.cpp con versión fijada que se prepara en el primer inicio. Alpine y otras distribuciones basadas en musl no son compatibles. El arranque desde el código fuente requiere Node 22.12+; Python 3 y una cadena de herramientas de compilación de C/C++ solo se necesitan cuando un paquete nativo de npm no tiene un binario precompilado compatible y hay que recompilarlo localmente.

**¿Orkas es gratis y de código abierto?**
Sí. La app tiene licencia MIT y su uso es gratuito. La app instalable incluye 500 créditos para el modelo integrado de Orkas; los planes de pago desde $11.99/mes agregan créditos mensuales, sincronización en la nube, más proyectos compartidos y publicación de apps. Con tus propias claves, el uso del modelo lo cobra tu proveedor; Orkas no agrega ningún margen adicional. [Precios →](https://orkas.ai/pricing/?source=gh-orkas)

---

## Licencia

[MIT](./LICENSE)
