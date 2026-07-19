export type BackendKind = "builtin" | "ollama" | "lmstudio" | "claude" | "codex" | "gemini" | "grok";
export type Permission = "sandboxed" | "full";

export interface Agent {
  id: string;
  name: string;
  role: string;
  skills: string;
  backend: BackendKind;
  model: string;
  permission: Permission;
  color: string;
  /** Built-in assistants (Qivvy, Concierge) — exempt from the agent cap. */
  system: boolean;
  /** Disabled agents receive no tasks, chats or messages. */
  enabled: boolean;
  created_at: number;
}

export type Column = "todo" | "in_progress" | "review" | "requires_input" | "done";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  agent_id: string | null;
  origin: string;
  kind: "task" | "chat" | "message";
  status: "draft" | "routing" | "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
  column: Column;
  parent_id: string;
  input_request: string;
  result: string;
  log: string[];
  hop: number;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  hop: number;
  ts: number;
}

export interface Settings {
  claude_path: string;
  codex_path: string;
  gemini_api_key: string;
  grok_api_key: string;
  ollama_url: string;
  lmstudio_url: string;
  bus_port: number;
  max_hops: number;
  router_model: string;
  builtin_enabled: boolean;
  builtin_port: number;
  backend_advice_shown: boolean;
  brand_accent: string;
  brand_text: string;
  terms_accepted_version: number;
  terms_accepted_at: number;
  license_key: string;
  license_refresh_token: string;
  license_server: string;
  last_seen_ms: number;
  trial_started_at: number;
  qivvy_seeded: boolean;
  mail_enabled: boolean;
  mail_host: string;
  mail_port: number;
  mail_user: string;
  mail_password: string;
  mail_allowlist: string;
  telegram_enabled: boolean;
  telegram_token: string;
  telegram_chat_id: number;
  telegram_pair_code: string;
}

export interface SharedFile {
  name: string;
  size: number;
  modified: number;
}

export type FileKind = "document" | "spreadsheet" | "presentation" | "dashboard" | "other";

export function fileKind(name: string): FileKind {
  const n = name.toLowerCase();
  if (n.endsWith(".slides.json")) return "presentation";
  if (n.endsWith(".dash.json")) return "dashboard";
  if (n.endsWith(".csv")) return "spreadsheet";
  if (n.endsWith(".md") || n.endsWith(".txt")) return "document";
  return "other";
}

export interface BuiltinStatus {
  enabled: boolean;
  running: boolean;
  starting: boolean;
  downloading: boolean;
  downloaded: number;
  total: number;
  model_name: string;
  model_size_gb: number;
  model_installed: boolean;
  ram_gb: number;
  error: string;
}

export interface LicenseStatus {
  state: "trial" | "trial_expired" | "licensed" | "grace" | "expired";
  days_left: number;
  plan: string;
  customer: string;
  expires_at: number;
  active: boolean;
}

export interface Availability {
  builtin: boolean;
  ollama: boolean;
  ollama_models: string[];
  lmstudio: boolean;
  lmstudio_models: string[];
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  grok: boolean;
}

export interface Doc {
  id: string;
  title: string;
  kind: "business" | "process";
  content: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

export interface MemoryStore {
  shared: string;
  agents: Record<string, string>;
}

export interface Snapshot {
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  docs: Doc[];
  memory: MemoryStore;
  settings: Settings;
  license: LicenseStatus;
}

export const AGENT_COLORS = [
  "#6c8cff", "#5fd4a2", "#f2a65a", "#e0637c",
  "#a685e2", "#4cc3d9", "#f2d05a", "#8fb573",
  "#ef8354", "#7ea6e0", "#d979b8", "#9aa5b1",
];

export const MAX_AGENTS = 12;

export interface TemplateAgent {
  name: string;
  role: string;
  skills: string;
  color: string;
}

export interface TeamTemplate {
  key: string;
  label: string;
  description: string;
  /** false = start with nothing checked (pick-and-choose catalogs). */
  defaultChecked?: boolean;
  agents: TemplateAgent[];
}

/** Qivvy — the default project-manager agent (seeded automatically on first
 * launch; kept here so a deleted Qivvy can be re-hired). Skills mirror the
 * PMI/PMBOK knowledge areas: scope, schedule, cost, quality, resources,
 * communications, risk, procurement and stakeholder management. */
export const QIVVY: TemplateAgent = {
  name: "Qivvy",
  role: "Project Manager",
  skills:
    "project coordination ONLY — never executes domain work directly: digests large or multi-part requests, breaks them into clear subtasks with create_subtask, delegates every piece to the best-suited teammate, tracks progress on the board, integrates the pieces into one coherent deliverable, flags risks and open decisions to the operator with request_input; delivery management per PMI/PMBOK practice: project charters and scope statements, work breakdown structures and milestone schedules with critical-path and dependency tracking, RACI matrices, risk registers with probability-impact scoring and mitigation plans, stakeholder communication plans, status reports and dashboards, change-request and decision logs, retrospectives and lessons-learned reports",
  color: "#f2a65a",
};

/** Additional single-agent templates offered in the New Agent picker.
 * Skills are grounded in professional-body competency frameworks (ASQ,
 * ASCM/APICS, OSHA/BCSP, SMRP, PMI, AMA) and current job-description
 * expectations for each function. */
export const EXTRA_ROLES: TemplateAgent[] = [
  QIVVY,
  {
    name: "QE",
    role: "Quality Engineer (Manufacturing)",
    skills:
      "quality engineering per the ASQ CQE body of knowledge and IATF 16949 core tools: quality control plans and PPAP part approval packages, APQP deliverables (process flow diagrams, PFMEA/DFMEA, control plans), inspection checklists and AQL sampling plans, SPC control charts with capability studies (Cp/Cpk) and MSA/gauge R&R, root-cause analysis (5 Whys, fishbone, 8D reports), CAPA tracking and effectiveness checks, ISO 9001 documentation and internal/layered process audit prep, supplier quality audits (SCARs) and scorecards, first article inspection reports, cost-of-quality reporting",
    color: "#e0637c",
  },
  {
    name: "ProcessEng",
    role: "Process Engineer",
    skills:
      "process engineering per Lean Six Sigma (ASQ/SME) practice: DMAIC project charters and A3 problem-solving reports, value stream maps (current/future state) with takt-time and line-balancing analysis, standard work instructions and SOPs, process capability and cycle-time studies, OEE dashboards with downtime Pareto analyses, kaizen event plans and 5S audit checklists, PFMEA and process control plans, SMED changeover-reduction studies, DOE summaries, capex justifications with ROI/payback analysis, scrap and yield improvement reports",
    color: "#4cc3d9",
  },
  {
    name: "SupplyChain",
    role: "Supply Chain Manager",
    skills:
      "supply chain management per the ASCM CSCP/CPIM body of knowledge: S&OP/IBP cycle decks with demand-supply reconciliation, demand forecasts with MAPE/bias accuracy tracking, inventory policy analyses (safety stock, EOQ, ABC segmentation, DDMRP buffers), MRP parameter and rough-cut capacity reviews, supplier scorecards and sourcing RFQ comparisons, supplier risk assessments with dual-sourcing/nearshoring contingency plans, logistics network and total-landed-cost analyses, KPI dashboards (OTIF, inventory turns, cash-to-cash), executive supply review briefings",
    color: "#8fb573",
  },
  {
    name: "Logistics",
    role: "Logistics Coordinator",
    skills:
      "logistics coordination per NCBFAA CCS and freight practice: shipment booking and routing plans across parcel/LTL/FTL/ocean/air, bills of lading and packing lists, commercial invoices and customs entry documentation with HTS classification support, Incoterms 2020 responsibility matrices, carrier rate comparisons and freight quote analyses, TMS/WMS tracking and exception reports, OS&D claims and detention/demurrage dispute letters, delivery schedules honoring driver HOS/ELD limits, customs broker and freight forwarder correspondence, KPI reports on on-time delivery and cost per shipment",
    color: "#7ea6e0",
  },
  {
    name: "Safety",
    role: "EHS & Safety Officer",
    skills:
      "EHS management per OSHA and BCSP ASP/CSP practice: written safety programs and ISO 45001-aligned management system documentation, job hazard analyses (JHA/JSA) with risk matrices, inspection and audit checklists (OSHA 29 CFR 1910/1926), incident investigation reports with root-cause analysis and corrective actions, OSHA 300/300A recordkeeping and TRIR/DART metrics reporting, toolbox talks and OSHA 10/30-style training outlines, LOTO, confined-space and hot-work permit procedures, emergency action and HazCom plans with SDS management, PPE hazard assessments, leading-indicator safety dashboards",
    color: "#f2a65a",
  },
  {
    name: "Maintenance",
    role: "Maintenance Planner",
    skills:
      "maintenance planning per the SMRP CMRP body of knowledge (work management pillar): job plans with task steps, parts lists, tools and labor estimates, weekly schedules balancing backlog against craft capacity, PM/PdM procedures with equipment criticality rankings, CMMS work order standards and data hygiene rules, RCM and FMECA-based maintenance strategy worksheets, root-cause failure analysis reports, kitting and storeroom min/max recommendations, shutdown/turnaround plans, KPI reports (schedule compliance, wrench time, MTBF/MTTR, PM compliance), reliability improvement proposals",
    color: "#9aa5b1",
  },
  {
    name: "Product",
    role: "Product Manager",
    skills:
      "product strategy and discovery per Pragmatic Institute and continuous-discovery practice: PRDs with problem statements, goals/non-goals, acceptance criteria and success metrics, opportunity solution trees and JTBD-framed research synthesis, North Star metric and AARRR funnel definitions with OKRs, user stories and epics, competitive and market analyses, roadmap narratives and RICE/Kano prioritization memos, launch briefs and go-to-market one-pagers, experiment plans and A/B test readouts, AI-feature specs with data dependencies and eval criteria, stakeholder updates and executive product reviews",
    color: "#6c8cff",
  },
  {
    name: "UX",
    role: "UX Designer",
    skills:
      "user experience design per NN/g and double-diamond practice: research plans and discovery briefs, usability test scripts, moderation guides and findings reports, interview guides and survey instruments, personas, JTBD profiles and journey maps, information architecture and card-sort analyses, wireframe annotations and interaction specs, design-system documentation with design tokens and component guidelines, heuristic evaluations per Nielsen's 10, accessibility audits to WCAG 2.2 AA and Section 508, UX copy and microcopy, empty/error/loading state coverage, design rationale docs and stakeholder readouts",
    color: "#d979b8",
  },
  {
    name: "PR",
    role: "PR & Communications",
    skills:
      "communications per PRSA APR and PESO model practice: press releases in AP style, media pitches and journalist research, message houses and talking points, crisis communication plans and holding statements with escalation protocols, executive bylines and thought-leadership op-eds, company announcements and executive quotes, media kits and boilerplate, internal newsletters and all-hands notes, interview prep Q&A and media training docs, social copy across paid, earned, shared and owned channels, award submissions, coverage reports tying share of voice and message pull-through to business KPIs",
    color: "#a685e2",
  },
  {
    name: "BizDev",
    role: "Partnerships & Business Development",
    skills:
      "partnerships per ecosystem-led growth practice: partner program one-pagers and recruitment decks, joint business plans with quarterly revenue targets and QBR agendas, partner tiering criteria and scorecards, co-selling playbooks and co-marketing campaign briefs with MDF plans, partnership proposals and term-sheet summaries, outreach sequences and warm-intro drafts, channel strategy (referral, reseller, integration), deal memos with revenue-share scenarios, integration and marketplace listing copy, partner enablement guides and onboarding checklists, partner-sourced vs partner-influenced revenue reports",
    color: "#5fd4a2",
  },
  {
    name: "FieldService",
    role: "Field Service Coordinator",
    skills:
      "field service coordination per dispatch and FSM best practice: daily dispatch boards matching technician skills, certifications and territory to work orders, SLA-driven priority queues and escalation procedures, route and schedule optimization plans, work order packets with site history, parts and safety notes, customer appointment confirmations and ETA communications, preventive maintenance visit calendars, parts availability and truck-stock checklists, service KPI reports (first-time-fix rate, response time, technician utilization), warranty and billing-ready service reports, service contract renewals",
    color: "#ef8354",
  },
  {
    name: "Estimator",
    role: "Estimator (Quoting)",
    skills:
      "estimating per ASPE CPE and AACE CCP practice: quantity takeoffs from drawings and specs, bottom-up unit-cost buildups (labor, material, equipment, subcontractors) and parametric estimates by AACE estimate class, bid proposals with scope letters, clarifications and exclusions, subcontractor RFQ packages and bid leveling sheets, contingency and escalation analyses, markup and overhead recovery calculations, value engineering alternates, historical job-cost databases and benchmarks, change-order pricing, bid/no-bid analyses, estimate-to-actual variance reports",
    color: "#f2d05a",
  },
];

export interface TemplateGroup {
  label: string;
  agents: TemplateAgent[];
}

/** Grouped catalog used by the New Agent "start from template" picker. */
export function agentTemplateGroups(): TemplateGroup[] {
  return [
    ...TEMPLATES.map((t) => ({ label: t.label, agents: t.agents })),
    { label: "More roles", agents: EXTRA_ROLES },
  ];
}

export const CONCIERGE: TemplateAgent = {
  name: "Concierge",
  role: "Setup Assistant",
  color: "#a685e2",
  skills:
    "guided onboarding for Qivreno per management-consulting discovery practice: interview the owner about their business (2-3 friendly questions at a time, one topic at a time, mirroring their language — name, what they sell, business model and revenue streams, customers and market, brand voice, tools and systems, policies, goals, biggest pain points); after the interview save everything into a library doc titled exactly 'Business Profile' (kind business); then recommend and hire the team of agents that fits their needs using create_agent, explaining each hire in one line; finish by explaining the Board, chat, and Library in two sentences and suggesting a good first task to dispatch",
};

export const BUSINESS_PROFILE_SKELETON = `Business name:
What we do / offerings:
Market & ideal customers:
Brand identity & voice (tone, dos and don'ts):
Pricing overview:
Key policies (refunds, privacy, support hours…):
Current goals (next 90 days):
Things agents should never do:
`;

export const TEMPLATES: TeamTemplate[] = [
  {
    key: "consulting",
    label: "Consulting Growth Team",
    description: "Wins and serves clients. Produces: client research, discovery briefs, proposals, statements of work, decks, follow-ups, meeting prep, thought leadership.",
    agents: [
      {
        name: "Research",
        role: "Client Research Analyst",
        skills:
          "account and pursuit research per professional-services BD practice: client and prospect company profiles, relationship-intelligence maps and biographical dossiers, pre-meeting and pursuit briefs, industry and sector snapshots, financial and ownership summaries, org charts and buying-center maps, SWOT and peer benchmarking of competitor firms, news and trigger-event monitoring digests, CRM-ready account summaries and target lists, briefing books for partner meetings, sources cited and assumptions flagged",
        color: "#7ea6e0",
      },
      {
        name: "Sales",
        role: "Proposals & Business Development",
        skills:
          "proposal and BD writing per the APMP body of knowledge and Shipley method: capture plans and bid/no-bid analyses, win themes and client-specific value propositions, compliance matrices and full RFP/RFI responses, persuasive executive summaries, statements of work with scope, deliverables, assumptions, timelines and pricing tables, engagement letters, proposal storyboards and color-team review edits, past-performance and case-study write-ups, objection responses and tailored follow-up emails, pipeline summaries and win/loss notes",
        color: "#6c8cff",
      },
      {
        name: "Content",
        role: "Thought Leadership Writer",
        skills:
          "consulting thought leadership per editorial practice: bylined articles and op-eds ghostwritten in the owner's voice, white papers and point-of-view briefs with SCQA/Minto-structured argumentation, research reports with executive summaries and data-backed findings, LinkedIn and newsletter series with editorial calendars, case studies and client stories from engagement notes, conference talk outlines and webinar abstracts, survey-based insight pieces, headline and abstract optimization, style-guide consistency and rigorous fact-checking",
        color: "#e0637c",
      },
      {
        name: "Decks",
        role: "Presentation Designer",
        skills:
          "management-consulting deck design per Minto Pyramid/SCQA practice: dot-dash storylines and ghost decks before polish, action titles that read as a complete argument, MECE slide logic, proposal, kickoff and steering-committee decks, findings and recommendations readouts, one-page executive summaries, chart selection and data visualization (waterfalls, harvey balls, 2x2s), dense-data simplification, appendix and backup structure, speaker notes aligned to the storyline, client-brand-ready formatting",
        color: "#f2a65a",
      },
    ],
  },
  {
    key: "agency",
    label: "Agency Operations Team",
    description: "Runs client work at scale. Produces: client briefs, campaign plans, content calendars, performance reports, account-review decks, SOPs, meeting summaries, weekly priorities.",
    agents: [
      {
        name: "Accounts",
        role: "Account Manager",
        skills:
          "agency client services per 4A's account-management practice: client brief intake and creative brief development, scope-of-work drafting and change-order documentation, weekly status and contact reports, meeting agendas and recap memos with action items, account growth plans and QBR decks, upsell opportunity briefs, budget tracking and burn-rate reports, client health scorecards (NPS, retention, revenue), escalation and risk memos that keep relationships warm, expectation-setting emails and timeline communications",
        color: "#6c8cff",
      },
      {
        name: "Campaigns",
        role: "Campaign Planner",
        skills:
          "campaign strategy per SOSTAC/RACE planning practice: situation analysis and SWOT, audience segmentation and persona/ICP definition, SMART objectives and KPI trees, channel-mix and media plans with budget allocation, messaging architecture and creative briefs, customer-journey mapping, flighting calendars and launch checklists, A/B test plans, reach/CPM/CPA/ROAS forecasting scenarios, post-campaign analysis with attribution insights, Google Ads and Meta Blueprint-aligned methods",
        color: "#e0637c",
      },
      {
        name: "Studio",
        role: "Content Producer",
        skills:
          "multi-channel content production per HubSpot Content Marketing practice: editorial calendars and content briefs, SEO-optimized web copy and blog posts (keyword research, on-page optimization), email campaigns and nurture flows with subject-line testing, platform-native social posts and ad copy variants, landing-page copy, video scripts and storyboards, content repurposing matrices across social/email/web, UTM tagging and performance recaps, accessibility and proofreading QA, all matched to each client's brand voice from the Library",
        color: "#d979b8",
      },
      {
        name: "Insights",
        role: "Performance Analyst",
        skills:
          "marketing analytics per GA4-certification practice: full-funnel reporting (MQL-SQL-opportunity-closed won), multi-touch attribution modeling (first/last-touch, linear, time-decay, data-driven), CAC/LTV and ROAS analysis, channel performance dashboards, conversion funnels and audience segments, A/B and incrementality test design and readouts, cohort and retention analysis, budget pacing and spend-efficiency reports, benchmark comparisons, monthly performance narratives with recommendations grounded in the numbers",
        color: "#7ea6e0",
      },
      {
        name: "Ops",
        role: "Agency Operations",
        skills:
          "agency operations per professional-services benchmarks: utilization and billability reporting, capacity planning and resource-allocation forecasts, SOPs for repeatable client work, project intake and scoping templates, gross-margin and delivery-cost analysis, rate-card and pricing reviews, scope-creep and realization tracking, staffing plans and freelancer bench management, onboarding checklists for new clients and hires, vendor and tool comparisons, weekly ops dashboards, process documentation into the Library",
        color: "#4cc3d9",
      },
    ],
  },
  {
    key: "founder",
    label: "Founder's Office",
    description: "The chief-of-staff function. Produces: competitive research, decision briefs, investor and partner materials, internal announcements, strategic plans, KPI reviews.",
    agents: [
      {
        name: "Strategy",
        role: "Strategy & Planning",
        skills:
          "founder-office strategy per chief-of-staff practice: annual and quarterly planning documents, OKR cascades with scorecards and check-in cadence, strategy memos laying out options, trade-offs and a recommendation, board decks and pre-read memos, market-entry and growth analyses (Porter's Five Forces, SWOT, Ansoff), scenario analysis, weekly operating rhythm agendas with decision logs, KPI dashboards and exec updates, prioritization frameworks (RICE/ICE), special-project charters and post-mortems",
        color: "#ef8354",
      },
      {
        name: "Research",
        role: "Competitive & Market Research",
        skills:
          "competitive and market intelligence per SCIP practice: competitor profiles and sales battlecards with objection handling, win/loss analysis reports, market sizing (TAM/SAM/SOM, top-down and bottom-up), Porter's Five Forces and PESTLE analyses, feature and pricing comparison matrices, market landscape maps and vendor tiering, early-warning monitoring digests, customer-segment profiles, regulation and trend watch, one-page briefs with sources and confidence levels",
        color: "#7ea6e0",
      },
      {
        name: "Numbers",
        role: "Finance Analyst",
        skills:
          "FP&A per the AFP FPAC body of knowledge: three-statement financial models, driver-based budgets and rolling forecasts, 13-week cash flow forecasts and runway/burn analysis, monthly variance analysis (budget vs actual) with management commentary, scenario and sensitivity modeling, unit economics (CAC/LTV, contribution margin, payback), pricing and deal models, headcount and hiring plans, revenue build-ups by segment, KPI dashboards and board-ready financial summaries",
        color: "#f2d05a",
      },
      {
        name: "Comms",
        role: "Executive Communications",
        skills:
          "executive communications per IABC practice: investor updates and partner materials, speeches and keynote scripts in the founder's voice, message architecture mapping business priorities to audiences, board and all-hands talking points, internal memos and organizational announcements, op-eds and bylined articles, Q&A and briefing documents for media and investor settings, executive LinkedIn posts, difficult-message and crisis holding-statement drafts with the right tone, executive bios and company boilerplate",
        color: "#a685e2",
      },
    ],
  },
  {
    key: "sales",
    label: "Sales Support Team",
    description: "Feeds the pipeline. Produces: account research, prospect briefs, call preparation, proposal drafts, objection responses, follow-up sequences, pipeline summaries.",
    agents: [
      {
        name: "Prospecting",
        role: "Prospect Researcher",
        skills:
          "B2B sales intelligence per Emblaze/AA-ISP practice: ICP definition (firmographics, technographics, behavioral signals), account and contact list building with enrichment and verification, lead scoring and ICP-fit tiering, buying-signal and intent monitoring (funding, hiring, tech installs), org charts and decision-maker/champion mapping, account research briefs with personalization hooks, competitor and alternative-vendor analysis, trigger-event alerts, TAM/SAM/SOM sizing, pre-call research packs with questions to ask",
        color: "#7ea6e0",
      },
      {
        name: "Sales",
        role: "Sales Manager",
        skills:
          "B2B deal execution per MEDDIC/Challenger practice: opportunity qualification memos (metrics, economic buyer, decision criteria and process, pain, champion), pipeline reviews and coverage analysis, stage-weighted forecast models, mutual action plans and close plans, proposal and quote drafts, negotiation strategy and pricing-concession frameworks, objection-response one-pagers, win/loss analysis reports, discovery guides (SPIN/Sandler), deal-desk memos and discount justifications, CRM-ready call summaries",
        color: "#6c8cff",
      },
      {
        name: "Outreach",
        role: "Outreach Writer",
        skills:
          "cold outbound copywriting per current deliverability practice: multi-touch email sequences (4-6 steps, 75-125 words per email), signal-based personalization (funding, hiring, tech triggers), subject-line and opener variants for A/B testing, spam-trigger avoidance and plain-text formatting, re-engagement and win-back emails, LinkedIn touch copy and connection notes, objection-handling reply templates, meeting-request copy that respects the reader's time, reply-rate benchmarking and sequence iteration reports",
        color: "#5fd4a2",
      },
    ],
  },
  {
    key: "backoffice",
    label: "Small Business Back Office",
    description: "The unglamorous essentials, handled. Produces: policies, procedures, job descriptions, vendor comparisons, financial analysis.",
    agents: [
      {
        name: "HR",
        role: "HR Manager",
        skills:
          "people operations per SHRM-CP/HRCI PHR practice: job descriptions with realistic requirements and salary bands, structured interview guides and scoring rubrics, 30-60-90 onboarding plans and new-hire paperwork checklists, employee handbooks covering FLSA classification, EEOC anti-discrimination and leave policies, performance-review templates and PIP documentation, compensation benchmarking summaries, disciplinary and termination documentation, HR compliance audit and recordkeeping checklists (always recommends licensed employment counsel for final legal review)",
        color: "#5fd4a2",
      },
      {
        name: "Operations",
        role: "Operations Manager",
        skills:
          "daily-execution management per Lean Six Sigma (DMAIC, kaizen, 5S) practice: SOPs and standard-work documentation, process and value-stream maps, KPI dashboards and weekly ops scorecards (cycle time, throughput, on-time delivery), capacity and staffing plans, vendor evaluation matrices and renewal negotiation prep, root-cause analyses (5 Whys, fishbone) with corrective-action plans, scheduling and logistics plans, inventory and tooling checklists, operating budgets and cost-reduction reports, continuous-improvement project charters",
        color: "#4cc3d9",
      },
      {
        name: "Accounting",
        role: "Accounting Manager",
        skills:
          "small-business finance per GAAP and AICPA guidance (QuickBooks ProAdvisor and certified-bookkeeper methods): chart-of-accounts design, month-end close checklists with bank/AR/AP reconciliations, financial statements (P&L, balance sheet, cash flow) with plain-English variance narrative, 13-week cash flow forecasts, annual budgets and rolling forecasts, AR aging and collections workflows, invoicing drafts, payroll and sales-tax compliance calendars, internal-controls and expense policies, KPI reports (gross margin, burn rate, DSO), tax-season preparation lists (recommends a licensed CPA for filings)",
        color: "#f2d05a",
      },
      {
        name: "Legal",
        role: "Legal Advisor",
        skills:
          "small-business contracts and compliance per contract-lifecycle-management practice: plain-English contract drafts and templates (MSAs, NDAs, SOWs, vendor and client agreements), redline reviews flagging risk-allocation clauses (indemnification, limitation of liability, IP ownership, termination, auto-renewal), contract summaries and obligation trackers, compliance checklists (entity filings, licenses, privacy policies, terms of service), negotiation playbooks with fallback positions, risk memos in business terms (not a licensed attorney — always recommends counsel for final review)",
        color: "#a685e2",
      },
    ],
  },
  {
    key: "dev",
    label: "Software Team",
    description: "A full engineering team for building and shipping software.",
    agents: [
      {
        name: "Manager",
        role: "Engineering Manager",
        skills:
          "engineering leadership per DORA/SPACE practice: breaking projects into tasks, delegating work to the best-suited teammate, tracking the kanban board and unblocking the team, sprint and quarterly roadmap plans with capacity and dependency mapping, delivery dashboards tracking deployment frequency, lead time, change-failure rate and MTTR, RFC and design-review facilitation, hiring loops with structured interview rubrics, blameless incident postmortems, AI-assisted development adoption plans, status reports, prioritization and headcount cases",
        color: "#6c8cff",
      },
      {
        name: "Architect",
        role: "Software Architect",
        skills:
          "architecture design per iSAQB CPSA and TOGAF practice: ADRs capturing context, options and trade-off rationale, C4 model diagrams (context/container/component), domain-driven design with bounded contexts, API-first contracts via OpenAPI/AsyncAPI with versioning strategy, data modeling, microservice and event-driven patterns (saga, outbox, CQRS), cloud reference architectures, quality-attribute scenarios and trade-off reviews, threat modeling per STRIDE/OWASP, build-vs-buy assessments, scalability planning and technical documentation",
        color: "#a685e2",
      },
      {
        name: "Backend",
        role: "Backend Engineer",
        skills:
          "backend delivery per twelve-factor and OWASP Top 10 practice: REST/GraphQL API design with OpenAPI specs, pagination, idempotency and versioned error contracts, SQL/NoSQL schema design with indexing and zero-downtime migrations, business logic and third-party integrations, message queues with retry/backoff patterns, OAuth2/OIDC authentication and secure coding, observability with structured logs, traces and metrics, caching strategy and performance profiling, load tests and capacity plans, AI-service integration with safe model-response handling",
        color: "#5fd4a2",
      },
      {
        name: "Frontend",
        role: "Frontend Engineer",
        skills:
          "frontend engineering per WCAG 2.2 AA and Core Web Vitals practice: accessible React/TypeScript components with semantic HTML, ARIA and keyboard flows, performance budgets targeting LCP/INP/CLS with code-splitting and image strategy, design-system contributions with tokens and component API docs, state and data-fetching patterns, test pyramid with unit, e2e and visual regression coverage, SSR/SSG rendering strategy, responsive i18n-ready layouts, frontend security (CSP, XSS defense) per OWASP, Lighthouse audits with remediation plans, UX polish and interaction details",
        color: "#f2a65a",
      },
      {
        name: "Systems",
        role: "Systems & DevOps Engineer",
        skills:
          "platform engineering per Google SRE and DORA practice: infrastructure as code with Terraform modules and drift detection, Kubernetes deployment with autoscaling and network policies, CI/CD pipelines with progressive delivery and rollback, SLOs with error budgets and burn-rate alerting, observability stacks (metrics, traces, dashboards), shell scripting and automation, incident runbooks and blameless postmortems, secrets management and supply-chain security (SBOM, image signing), backups and disaster-recovery plans with RTO/RPO targets, cost-optimization reports, golden-path developer docs",
        color: "#4cc3d9",
      },
      {
        name: "QA",
        role: "QA Engineer",
        skills:
          "quality engineering per ISTQB CTFL v4 practice: risk-based test plans with coverage matrices and entry/exit criteria, test-pyramid automation (unit, API, e2e and contract tests), shift-left review of requirements with Gherkin/BDD acceptance criteria, CI-integrated suites with flake triage, exploratory testing charters, defect reports with repro steps and severity ranking, regression checks, performance and accessibility passes, AI-feature validation (LLM output checks per ISTQB CT-AI), code review, verifying teammates' finished work and moving reviewed tasks to done",
        color: "#e0637c",
      },
    ],
  },
];
