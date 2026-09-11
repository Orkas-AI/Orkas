export interface BuiltinAgentToolSurfaceCase {
  agentId: string;
  name: string;
  configuredGroups: string[];
  /** One user-workflow reason for every configured group, plus tools whose
   * disappearance independently proves that removing the group breaks it. */
  groupRequirements: Array<{
    group: string;
    outcome: string;
    witnessTools: string[];
  }>;
  /** Controlled negative mutations: replacing a narrow group with its parent
   * must expose the named tool and therefore fail the fixed-boundary review. */
  overbroadReplacements?: Array<{
    narrowGroup: string;
    broadGroup: string;
    newlyExposedTool: string;
  }>;
  requiredTools: string[];
  forbiddenTools: string[];
}

/**
 * Product-level fixed capability decisions for the built-in Agents.
 * `configuredGroups` is a hard runtime boundary, not a preload hint.
 */
export const BUILTIN_AGENT_TOOL_SURFACE_CASES: readonly BuiltinAgentToolSurfaceCase[] = [
  {
    agentId: '173d4235a431',
    name: 'ContentWriter',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect supplied source packs', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist evidence and requested editorial files', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run deterministic content gates', witnessTools: ['bash'] },
      { group: 'web', outcome: 'research current or externally sourced claims', witnessTools: ['web_search', 'web_fetch'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'list_files', 'write_file', 'bash', 'web_search', 'web_fetch'],
    forbiddenTools: [
      'edit_file', 'delete_file', 'workspace_diff', 'process_session', 'interactive_cli',
      'library', 'create_pptx', 'create_artifact', 'generate_image',
    ],
  },
  {
    agentId: '78900d8758bc',
    name: 'DeepResearcher',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect supplied corpora and durable research state', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'write and append durable ledgers and reports', witnessTools: ['write_file', 'append_file'] },
      { group: 'workspace.execute.command', outcome: 'run bounded research verifiers', witnessTools: ['bash'] },
      { group: 'web', outcome: 'discover, fetch, and verify primary evidence', witnessTools: ['web_search', 'web_fetch', 'research_verify_citations'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'apply_patch' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'interactive_cli' },
    ],
    requiredTools: ['list_files', 'write_file', 'bash', 'web_search', 'web_fetch', 'research_verify_citations'],
    forbiddenTools: [
      'apply_patch', 'edit_file', 'delete_file', 'process_session', 'interactive_cli',
      'library', 'create_pptx', 'create_artifact', 'generate_image',
    ],
  },
  {
    agentId: '79df9cc89f5f',
    name: 'VideoStudio',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute.command', 'media'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect supplied media and durable manifests', witnessTools: ['list_files'] },
      { group: 'workspace.write', outcome: 'create manifests and repair existing candidates', witnessTools: ['write_file', 'edit_file'] },
      { group: 'workspace.execute.command', outcome: 'run deterministic media scripts and checks', witnessTools: ['bash'] },
      { group: 'media', outcome: 'generate stills and narration, and run VideoStudio', witnessTools: ['generate_image', 'generate_speech', 'video_studio'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: [
      'list_files', 'write_file', 'edit_file', 'bash',
      'generate_image', 'generate_speech', 'video_studio',
    ],
    forbiddenTools: ['process_session', 'interactive_cli', 'create_pptx', 'create_artifact', 'image_studio'],
  },
  {
    agentId: '7e91cb9ec9e9',
    name: 'PptMaker',
    configuredGroups: ['workspace.read', 'office.presentation'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect source files and presentation references', witnessTools: ['list_files'] },
      { group: 'office.presentation', outcome: 'create, edit, render, and review PPTX decks', witnessTools: ['create_pptx', 'office_review'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'office.presentation', broadGroup: 'office', newlyExposedTool: 'create_xlsx' },
    ],
    requiredTools: ['list_files', 'create_pptx', 'office_read', 'edit_office', 'office_review'],
    forbiddenTools: [
      'write_file', 'bash', 'generate_image', 'create_artifact',
      'create_docx', 'create_xlsx', 'create_pdf', 'edit_pdf', 'pdf_render',
    ],
  },
  {
    agentId: '814b61b027f0',
    name: 'ImageStudio',
    configuredGroups: ['workspace.write', 'workspace.execute.command', 'media.image'],
    groupRequirements: [
      { group: 'workspace.write', outcome: 'create manifests and repair the current composition', witnessTools: ['write_file', 'edit_file'] },
      { group: 'workspace.execute.command', outcome: 'run deterministic image composition scripts', witnessTools: ['bash'] },
      { group: 'media.image', outcome: 'generate and inspect image candidates', witnessTools: ['generate_image', 'image_studio'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
      { narrowGroup: 'media.image', broadGroup: 'media', newlyExposedTool: 'generate_speech' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'generate_image', 'image_studio'],
    forbiddenTools: [
      'list_files', 'process_session', 'interactive_cli',
      'generate_speech', 'create_pptx', 'create_artifact', 'video_studio',
    ],
  },
  {
    agentId: 'a19101ba698a',
    name: 'OfficeWorker',
    configuredGroups: ['workspace.read', 'office'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'find, inspect, and OCR supplied Office sources', witnessTools: ['search_files', 'ocr_file'] },
      { group: 'office', outcome: 'deliver Word, spreadsheet, presentation, and PDF tasks', witnessTools: ['create_docx', 'create_xlsx', 'create_pptx', 'create_pdf'] },
    ],
    requiredTools: [
      'list_files', 'create_docx', 'create_xlsx', 'create_pptx',
      'create_pdf', 'edit_pdf', 'pdf_render', 'office_review',
    ],
    forbiddenTools: ['write_file', 'bash', 'generate_image', 'create_artifact'],
  },
  {
    agentId: 'a316881746f9',
    name: 'ProductDeveloper',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute', 'workspace.artifact'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect repositories and instructions', witnessTools: ['list_files', 'grep_files'] },
      { group: 'workspace.write', outcome: 'create and patch product files safely', witnessTools: ['write_file', 'apply_patch'] },
      { group: 'workspace.execute', outcome: 'run checks and persistent development processes', witnessTools: ['bash', 'process_session'] },
      { group: 'workspace.artifact', outcome: 'build and visually verify standalone UI artifacts', witnessTools: ['create_artifact', 'html_preview'] },
    ],
    requiredTools: ['list_files', 'write_file', 'apply_patch', 'bash', 'process_session', 'create_artifact', 'html_preview'],
    forbiddenTools: ['web_search', 'create_pptx', 'generate_image'],
  },
  {
    agentId: 'bcfcb4921dce',
    name: 'UIDesigner',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute', 'workspace.artifact'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect repositories, artifacts, and design references', witnessTools: ['list_files'] },
      { group: 'workspace.write', outcome: 'create and revise canonical UI files', witnessTools: ['write_file', 'edit_file'] },
      { group: 'workspace.execute', outcome: 'run validators and live preview processes', witnessTools: ['bash', 'process_session'] },
      { group: 'workspace.artifact', outcome: 'create and visually inspect interactive UI artifacts', witnessTools: ['create_artifact', 'html_preview'] },
    ],
    requiredTools: ['list_files', 'write_file', 'edit_file', 'bash', 'process_session', 'create_artifact', 'html_preview'],
    forbiddenTools: ['create_pptx', 'web_search', 'generate_image'],
  },
  {
    agentId: 'e064dca9e1bd',
    name: 'SeoGeoAgent',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute.command', 'web', 'connectors'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect site repositories and protected sibling files', witnessTools: ['list_files'] },
      { group: 'workspace.write', outcome: 'write reports and apply authorized source fixes', witnessTools: ['write_file', 'edit_file'] },
      { group: 'workspace.execute.command', outcome: 'run deterministic SEO audit scripts', witnessTools: ['bash'] },
      { group: 'web', outcome: 'perform public discovery and visibility probes', witnessTools: ['web_search', 'web_fetch'] },
      { group: 'connectors', outcome: 'read every enabled search-console source', witnessTools: ['list_connector_tools', 'call_connector_tool'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'interactive_cli' },
    ],
    requiredTools: [
      'list_files', 'write_file', 'edit_file', 'bash', 'web_search', 'web_fetch',
      'list_connector_tools', 'call_connector_tool',
    ],
    forbiddenTools: [
      'process_session', 'interactive_cli',
      'library', 'create_pptx', 'create_artifact', 'generate_image',
    ],
  },
] as const;

/**
 * Reviewed fixed capability decisions for the Resource marketplace Agents.
 * These packages are installed into the same platform marketplace root as the
 * built-ins, so they must obey the same runtime boundary without relying on a
 * Skill being installed to supply native tools.
 */
export const RESOURCE_AGENT_TOOL_SURFACE_CASES: readonly BuiltinAgentToolSurfaceCase[] = [
  {
    agentId: '1040b336306f',
    name: 'StockAnalyser',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web', 'connectors'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect supplied market, strategy, and portfolio data', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'save explicitly requested analysis and experiment reports', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run the deterministic financial analysis core', witnessTools: ['bash'] },
      { group: 'web', outcome: 'verify current filings, issuer facts, and market events', witnessTools: ['web_search', 'web_fetch'] },
      { group: 'connectors', outcome: 'read connected Longbridge data and perform explicitly authorized broker actions', witnessTools: ['list_connector_tools', 'call_connector_tool'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: [
      'list_files', 'read_files', 'write_file', 'bash', 'web_search', 'web_fetch',
      'list_connector_tools', 'call_connector_tool',
    ],
    forbiddenTools: [
      'edit_file', 'delete_file', 'process_session', 'interactive_cli',
      'library', 'create_pptx', 'create_artifact', 'generate_image',
    ],
  },
  {
    agentId: '14ba06897645',
    name: 'StudyTutor',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect syllabus and rich learning materials', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist knowledge-map inputs and requested study artifacts', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run knowledge-map validators and renderers', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash'],
    forbiddenTools: ['edit_file', 'process_session', 'web_search', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '17c0a2e95df3',
    name: 'SocialResearcher',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect campaign exports and durable evidence state', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist evidence ledgers and requested research reports', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run social-data and research verification scripts', witnessTools: ['bash'] },
      { group: 'web', outcome: 'fetch and verify public brand and broader source evidence', witnessTools: ['web_search', 'web_fetch', 'research_verify_citations'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'web_search', 'web_fetch', 'research_verify_citations'],
    forbiddenTools: ['edit_file', 'process_session', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '21fd0c5eed7a',
    name: 'GrowthAdvisor',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect product, page, and analytics inputs', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'save requested strategy and campaign modules', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'validate machine-readable analytics specifications', witnessTools: ['bash'] },
      { group: 'web', outcome: 'verify current market, SEO, pricing, or competitor facts', witnessTools: ['web_search'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'web_search'],
    forbiddenTools: ['edit_file', 'process_session', 'create_pptx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '3fdf5e971f41',
    name: 'ProductAnalyst',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect requirement and interview materials', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'save requested PRD and acceptance artifacts', witnessTools: ['write_file'] },
      { group: 'web', outcome: 'verify current competitors and public product facts', witnessTools: ['web_search'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
    ],
    requiredTools: ['read_files', 'write_file', 'web_search'],
    forbiddenTools: ['edit_file', 'bash', 'process_session', 'create_artifact', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '489b72e5801c',
    name: 'MathTutor',
    configuredGroups: ['workspace.read', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect photographed or document-backed math work', witnessTools: ['list_files', 'ocr_file'] },
      { group: 'workspace.execute.command', outcome: 'run auditable calculator verification', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'ocr_file', 'bash'],
    forbiddenTools: ['write_file', 'process_session', 'web_search', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '54fc8129a8c4',
    name: 'LearningTutor',
    configuredGroups: ['workspace.read', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect learner-provided readings and problem files', witnessTools: ['list_files'] },
      { group: 'workspace.execute.command', outcome: 'run transparent calculation checks when needed', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'bash'],
    forbiddenTools: ['write_file', 'process_session', 'web_search', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '5a1d43c2f28a',
    name: 'MerchResearcher',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect marketplace exports and product evidence', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist research evidence and requested opportunity reports', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run social-data and deep-research scripts', witnessTools: ['bash'] },
      { group: 'web', outcome: 'gather and verify public market and brand evidence', witnessTools: ['web_search', 'web_fetch'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'web_search', 'web_fetch'],
    forbiddenTools: ['edit_file', 'process_session', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: '5dd962efb425',
    name: 'KnowledgeManager',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute.command', 'web', 'connectors'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'scan supplied folders and extract mixed source materials', witnessTools: ['list_files'] },
      { group: 'workspace.write', outcome: 'create and safely revise authorized local knowledge files', witnessTools: ['write_file', 'edit_file'] },
      { group: 'workspace.execute.command', outcome: 'run authorized Obsidian CLI operations', witnessTools: ['bash'] },
      { group: 'web', outcome: 'read and verify user-supplied source links without broadening the research scope', witnessTools: ['web_fetch', 'research_verify_citations'] },
      { group: 'connectors', outcome: 'search and update an authorized Notion workspace', witnessTools: ['list_connector_tools', 'call_connector_tool'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['list_files', 'read_files', 'write_file', 'edit_file', 'bash', 'web_fetch', 'research_verify_citations', 'list_connector_tools', 'call_connector_tool'],
    forbiddenTools: ['process_session', 'create_artifact', 'create_docx', 'generate_image'],
  },
  {
    agentId: '7083ff63b398',
    name: 'BrandResearcher',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect durable evidence state and supplied brand materials', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist evidence ledgers and requested Brand DNA files', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run social-data and deep-research verification', witnessTools: ['bash'] },
      { group: 'web', outcome: 'research and verify first-party and public brand sources', witnessTools: ['web_search', 'web_fetch', 'research_verify_citations'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['list_files', 'write_file', 'bash', 'web_search', 'web_fetch', 'research_verify_citations'],
    forbiddenTools: ['edit_file', 'process_session', 'create_pptx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'a4690dc27b0b',
    name: 'ResearchTutor',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect papers, drafts, and durable research state', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist research ledgers and requested learning artifacts', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run paper and deep-research scripts', witnessTools: ['bash'] },
      { group: 'web', outcome: 'discover and verify scholarly and public sources', witnessTools: ['web_search', 'web_fetch'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'web_search', 'web_fetch'],
    forbiddenTools: ['edit_file', 'process_session', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'a4930d19ba6c',
    name: 'MerchReviewer',
    configuredGroups: ['workspace.read', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'extract review exports and feedback documents', witnessTools: ['list_files'] },
      { group: 'workspace.execute.command', outcome: 'run social sample and metric analysis scripts', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'bash'],
    forbiddenTools: ['write_file', 'process_session', 'web_search', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'cca3f16d3a01',
    name: 'FamilyTutor',
    configuredGroups: ['workspace.read', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect supplied learning and homework materials', witnessTools: ['list_files'] },
      { group: 'workspace.execute.command', outcome: 'run transparent calculation checks for bounded support', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'bash'],
    forbiddenTools: ['write_file', 'process_session', 'web_search', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'd76b91de8c7b',
    name: 'ProductDemoBuilder',
    configuredGroups: ['workspace.read', 'workspace.write', 'workspace.execute', 'workspace.artifact'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect the target stack and existing product files', witnessTools: ['list_files', 'grep_files'] },
      { group: 'workspace.write', outcome: 'create and revise the runnable demo', witnessTools: ['write_file', 'apply_patch'] },
      { group: 'workspace.execute', outcome: 'run builds, checks, and live demo processes', witnessTools: ['bash', 'process_session'] },
      { group: 'workspace.artifact', outcome: 'build and visually inspect a standalone interactive demo', witnessTools: ['create_artifact', 'html_preview'] },
    ],
    requiredTools: ['list_files', 'grep_files', 'write_file', 'apply_patch', 'bash', 'process_session', 'create_artifact', 'html_preview'],
    forbiddenTools: ['web_search', 'create_pptx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'dd3729b7ac15',
    name: 'TeacherToolkit',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect syllabus and classroom source materials', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'persist editable teacher artifacts and knowledge maps', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'run knowledge-map validators and renderers', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash'],
    forbiddenTools: ['edit_file', 'process_session', 'web_search', 'create_docx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'e9d871eef7d8',
    name: 'ProductReviewer',
    configuredGroups: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect analytics exports, feedback, and experiment evidence', witnessTools: ['list_files'] },
      { group: 'workspace.write.output', outcome: 'save requested instrumentation or review artifacts', witnessTools: ['write_file'] },
      { group: 'workspace.execute.command', outcome: 'validate machine-readable analytics specifications', witnessTools: ['bash'] },
      { group: 'web', outcome: 'verify decision-changing market and competitor facts', witnessTools: ['web_search'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.write.output', broadGroup: 'workspace.write', newlyExposedTool: 'edit_file' },
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['read_files', 'write_file', 'bash', 'web_search'],
    forbiddenTools: ['edit_file', 'process_session', 'create_artifact', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'f7ff924175dc',
    name: 'SocialWriter',
    configuredGroups: ['workspace.read', 'web', 'connectors'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect source drafts and local media inputs', witnessTools: ['list_files'] },
      { group: 'web', outcome: 'verify current public claims and platform rules', witnessTools: ['web_fetch'] },
      { group: 'connectors', outcome: 'prepare a draft in an enabled visible-browser connector', witnessTools: ['list_connector_tools', 'call_connector_tool'] },
    ],
    requiredTools: ['read_files', 'web_fetch', 'list_connector_tools', 'call_connector_tool'],
    forbiddenTools: ['write_file', 'bash', 'process_session', 'create_pptx', 'generate_image'],
  },
  {
    agentId: 'fa18f60c173d',
    name: 'GithubMaintainer',
    configuredGroups: ['workspace.read', 'workspace.execute.command'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'inspect repository policy and maintainer guidance', witnessTools: ['list_files', 'grep_files'] },
      { group: 'workspace.execute.command', outcome: 'read and perform authorized GitHub actions through gh', witnessTools: ['bash'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.execute.command', broadGroup: 'workspace.execute', newlyExposedTool: 'process_session' },
    ],
    requiredTools: ['list_files', 'grep_files', 'bash'],
    forbiddenTools: ['write_file', 'process_session', 'web_search', 'create_artifact', 'generate_image', 'list_connector_tools'],
  },
  {
    agentId: 'fa3e1f2f9e07',
    name: 'MerchPageOptimizer',
    configuredGroups: ['workspace.read'],
    groupRequirements: [
      { group: 'workspace.read', outcome: 'extract verified product facts and VOC source materials', witnessTools: ['list_files'] },
    ],
    overbroadReplacements: [
      { narrowGroup: 'workspace.read', broadGroup: 'workspace', newlyExposedTool: 'write_file' },
    ],
    requiredTools: ['read_files'],
    forbiddenTools: ['write_file', 'bash', 'process_session', 'web_search', 'create_xlsx', 'generate_image', 'list_connector_tools'],
  },
] as const;

export const OFFICIAL_AGENT_TOOL_SURFACE_CASES: readonly BuiltinAgentToolSurfaceCase[] = [
  ...BUILTIN_AGENT_TOOL_SURFACE_CASES,
  ...RESOURCE_AGENT_TOOL_SURFACE_CASES,
];
