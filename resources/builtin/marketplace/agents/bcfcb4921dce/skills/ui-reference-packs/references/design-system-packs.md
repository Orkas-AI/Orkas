# Curated Design-System Packs

These packs are compact UIDesigner references inspired by OpenDesign's `design-systems/` catalogue. They are neutral archetypes, not templates, and must not be used to imitate a named brand. Use them to translate a contract into token roles, component behavior, density, and visual attitude.

## Selection Rules

- Pick one primary pack that matches the user's product job.
- Add one secondary influence only when it clarifies a specific axis, such as editorial type, developer precision, or mobile tactility.
- Existing product tokens and screenshot structure outrank every pack.
- If the user asks for "like X", map the request to the closest neutral archetype, preserve controllable qualities, and avoid protected assets, exact layout, logos, slogans, and distinctive product claims.

## Packs

| Pack | Use when | Design DNA | Avoid when |
| --- | --- | --- | --- |
| `product-application` | General SaaS app screens, settings, account workflows, lightweight admin tools. | Balanced density, clear controls, neutral surfaces, practical hierarchy, 4/8/12/16 spacing. | The source is a homepage/input screen with no app shell, or a more specific pack fits. |
| `enterprise-operations` | B2B workflows, compliance, operations, approval, procurement, CRM, internal tools. | Conservative contrast, predictable navigation, form/table strength, restrained motion, stable state handling. | Consumer, playful, editorial, or highly visual brand pages. |
| `dense-enterprise-crud` | Data-dense Chinese/enterprise CRUD, configuration, tables, filters, admin consoles. | Compact controls, clear table affordances, status chips, dense form groups, 4/8 grid. | Sparse landing pages, creative products, or screenshot structures without tables/forms. |
| `analytics-monitoring` | Explicit dashboards, analytics, monitoring, KPI walls, incident/ops views. | Metrics, trend regions, filters, chart labeling, drilldown affordances, semantic status. | Any task where dashboard elements are not visible or requested. |
| `project-workflow` | Issue tracking, project management, roadmap, developer-product planning, command-driven workflows. | Calm dark/light neutrals, sharp hierarchy, compact rows, keyboard-friendly navigation, minimal decoration. | Marketing pages, finance dashboards, or broad consumer apps. |
| `developer-code` | Developer tools, repositories, code review, CI, API docs, package/project surfaces. | System fonts, monospace where meaningful, borders over shadows, readable lists, status labels. | Non-technical consumer products or highly branded campaign pages. |
| `developer-platform` | Deployment, cloud, developer platform, build logs, infra/project dashboards. | Minimal neutrals, code/console affordances, tight type, precise cards and tables. | Warm consumer brands or dense enterprise CRUD needing many form controls. |
| `creative-canvas` | Design/canvas tools, creative collaboration, component libraries, prototyping surfaces. | Canvas-first layout, toolbars, panels, layered controls, colorful accents used sparingly. | Non-creative app screens where canvas metaphors would distract. |
| `docs-knowledge` | Docs, wiki, knowledge base, notes, lightweight databases, content organization. | Warm neutrals, readable blocks, inline controls, calm hierarchy, low-chrome UI. | Dense monitoring, trading, or task-critical operations. |
| `cross-platform-material` | Android-like apps, cross-platform component systems, form-heavy surfaces. | Familiar component taxonomy, elevation rules, clear state layers, accessible control defaults. | Products with a strong existing custom system or desktop enterprise density needs. |
| `consumer-premium` | Consumer product pages, mobile/desktop app surfaces, premium hardware/software storytelling. | Image-led clarity, large type only where justified, restrained chrome, tactile motion. | Internal tools, CRUD dashboards, or anything where merchandising would reduce task efficiency. |
| `fintech-trust` | Payments, fintech onboarding, developer docs, commercial SaaS with trust and conversion needs. | Crisp hierarchy, confident accent use, trust cues, code/API affordances, strong section rhythm. | Regulated finance dashboards needing dense tabular risk scanning. |
| `focused-minimal` | Utility tools, focused settings, simple product flows, content-light apps. | Few colors, strong alignment, quiet surfaces, clear type roles, very limited ornament. | Data-heavy workflows needing many comparison affordances. |
| `professional-clean` | Broad professional UI where the existing brand is weak and the safest path is clarity. | Neutral palette, 8pt rhythm, familiar controls, conservative spacing, low visual risk. | Requests for distinctive brand expression or explicit visual experimentation. |
| `editorial-story` | Long-form content, reports, landing/storytelling, magazine-like product narratives. | Strong type contrast, measured whitespace, image/caption rhythm, narrative hierarchy. | Repeated operational workflows or compact tool surfaces. |
| `experimental-bold` | Posters, campaign microsites, experimental portfolios, strong attitude pieces. | Bold type, high contrast, visible grid, intentionally raw surfaces. | Enterprise, accessibility-sensitive, compliance-heavy, or daily-use tools unless explicitly requested. |

## Token Translation

Translate pack DNA into UIDesigner roles:

- Color: `bg`, `surface`, `surface-raised`, `text`, `text-muted`, `border`, `accent`, semantic roles, chart roles.
- Type: `display`, `title`, `body`, `label`, `data`, `caption`.
- Spacing: compact 4/8 scale for tools; 8pt editorial rhythm for content/marketing.
- Shape: derive radius from the selected product context and Visual Thesis; prefer restrained geometry for dense work tools, but allow sharper or softer controls when the subject and interaction model justify them.
- Motion: state-change motion first; ambient motion only for brand/storytelling.

## Rejection Examples

- Source image is a chat/input homepage: reject `analytics-monitoring`, `dense-enterprise-crud`, and `project-workflow` unless the user asks to redesign it into a workspace.
- User asks for a pricing page: pick a pricing pattern first, then choose `fintech-trust`, `developer-platform`, `professional-clean`, or `editorial-story` by brand tone.
- User asks for a developer tool settings page: `developer-code` or `developer-platform` fits better than generic `product-application`.
- User gives a brand screenshot with a unique logo: keep density, color temperature, and rhythm; do not copy the mark or exact composition.
