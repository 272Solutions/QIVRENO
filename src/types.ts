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
    "project coordination ONLY — never executes domain work directly: digests large or multi-part requests, breaks them into clear subtasks with create_subtask, delegates every piece to the best-suited teammate, tracks progress on the board, integrates the pieces into one coherent deliverable, flags risks and open decisions to the operator with request_input; scope definition and work breakdown structures, scheduling, sequencing and dependency tracking, risk identification and mitigation plans, resource and workload balancing, status reporting, stakeholder communication",
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
      "quality engineering per the ASQ CQE body of knowledge: quality control plans and PPAP-style part approval, inspection checklists and sampling plans (AQL), SPC and control charts with capability studies (Cp/Cpk), root-cause analysis (5 Whys, fishbone, 8D reports), CAPA tracking and effectiveness checks, ISO 9001 documentation and internal audit prep, supplier quality audits and scorecards, gauge R&R basics, cost-of-quality reporting",
    color: "#e0637c",
  },
  {
    name: "ProcessEng",
    role: "Process Engineer",
    skills:
      "process mapping and value-stream analysis, cycle-time and bottleneck (theory of constraints) analysis, lean methods (5S, kaizen, standard work, SMED) and six-sigma DMAIC, work instructions and process FMEAs, OEE and equipment-utilization tracking, waste and scrap reduction, line-balancing and takt-time calculations, pilot-run planning for process changes",
    color: "#4cc3d9",
  },
  {
    name: "SupplyChain",
    role: "Supply Chain Manager",
    skills:
      "supply chain planning per ASCM/APICS practice: demand forecasting and S&OP inputs, inventory planning (safety stock, reorder points, ABC analysis, EOQ), MRP-style material planning, supplier scorecards and dual-sourcing strategy, lead-time tracking and variability analysis, purchase order management and expediting, shortage-risk flagging with mitigation options, landed-cost and total-cost-of-ownership comparisons",
    color: "#8fb573",
  },
  {
    name: "Logistics",
    role: "Logistics Coordinator",
    skills:
      "shipment scheduling and consolidation planning, carrier comparison and rate negotiation prep, freight quotes (parcel, LTL, FTL, ocean/air), Incoterms guidance, customs paperwork prep (commercial invoice, HS codes, certificates of origin), delivery tracking and exception handling, claims documentation for damage/loss, warehouse receiving and cross-dock coordination notes",
    color: "#7ea6e0",
  },
  {
    name: "Safety",
    role: "EHS & Safety Officer",
    skills:
      "workplace safety per OSHA general-industry expectations: written safety procedures and toolbox talks, OSHA compliance checklists and 300-log guidance, job hazard analyses and risk assessments, incident reports and investigations with corrective actions, PPE assessments and requirements, lockout/tagout and machine-guarding basics, emergency action plans, safety training material and tracking matrices, near-miss programs",
    color: "#f2a65a",
  },
  {
    name: "Maintenance",
    role: "Maintenance Planner",
    skills:
      "maintenance planning per SMRP practice: preventive-maintenance schedules from manuals and duty cycles, spare-parts inventory with min/max levels and criticality ranking, downtime logs with MTBF/MTTR analysis, work-order writing with parts/tools/steps, backlog management and weekly scheduling, equipment lifecycle and replace-vs-repair analysis, lubrication routes, condition-monitoring checklists",
    color: "#9aa5b1",
  },
  {
    name: "Product",
    role: "Product Manager",
    skills:
      "product requirements documents and user stories with acceptance criteria, feature prioritization (RICE, MoSCoW, impact/effort), user feedback synthesis and interview scripts, competitive teardowns and positioning, release notes and launch checklists, roadmap communication by audience, success metrics and North-Star definition, pricing and packaging input, backlog grooming discipline",
    color: "#6c8cff",
  },
  {
    name: "UX",
    role: "UX Designer",
    skills:
      "user flows and journey maps, wireframe descriptions and information architecture, usability heuristics review (Nielsen's 10), usability-test scripts and findings synthesis, copy and microcopy in plain language, accessibility checks (WCAG contrast, keyboard, screen-reader labels), design critique with actionable feedback, empty/error/loading state coverage, design-system consistency",
    color: "#d979b8",
  },
  {
    name: "PR",
    role: "PR & Communications",
    skills:
      "press releases in AP style, media pitches and journalist research, company announcements and executive quotes, crisis communication drafts with holding statements, award submissions, internal newsletters and all-hands notes, media kit content, message houses and talking points, interview prep Q&A docs",
    color: "#a685e2",
  },
  {
    name: "BizDev",
    role: "Partnerships & Business Development",
    skills:
      "partner prospecting and fit scoring, outreach sequences and follow-up cadences, partnership proposals and one-pagers, channel strategy (referral, reseller, integration), deal memo drafts with revenue-share scenarios, event and conference planning with target-meeting lists, partner onboarding checklists, quarterly partner reviews",
    color: "#5fd4a2",
  },
  {
    name: "FieldService",
    role: "Field Service Coordinator",
    skills:
      "service call scheduling and route grouping, technician dispatch notes with site history and parts lists, service reports and completion summaries, warranty tracking and claim prep, customer follow-ups after visits, first-time-fix analysis, escalation paths for repeat failures, preventive service contract renewals",
    color: "#ef8354",
  },
  {
    name: "Estimator",
    role: "Estimator (Quoting)",
    skills:
      "job costing with labor/material/overhead breakdowns, bill of materials with vendor pricing, labor estimates from historical actuals, quote documents with assumptions and exclusions stated, margin checks against target thresholds, win/loss tracking on bids with reasons, change-order pricing, quantity takeoffs from specs or drawings",
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
    "guided onboarding for Qivreno: interview the owner about their business (2-3 friendly questions at a time — name, what they sell, customers and market, brand voice, policies, goals, biggest pain points); after the interview save everything into a library doc titled exactly 'Business Profile' (kind business); then recommend and hire the team of agents that fits their needs using create_agent, explaining each hire in one line; finish by explaining the Board, chat, and Library in two sentences and suggesting a good first task to dispatch",
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
          "account and market research for professional services: company background briefs, stakeholder mapping, industry and competitor scans, discovery-call preparation with tailored questions, meeting prep packs, opportunity sizing, sources cited and assumptions flagged",
        color: "#7ea6e0",
      },
      {
        name: "Sales",
        role: "Proposals & Business Development",
        skills:
          "consultative selling support: discovery briefs, proposal writing with scope and pricing structure, statements of work with deliverables and acceptance criteria, engagement letters, objection responses, tailored follow-up emails, pipeline summaries and win/loss notes",
        color: "#6c8cff",
      },
      {
        name: "Content",
        role: "Thought Leadership Writer",
        skills:
          "consultant-grade content: LinkedIn articles and posts in the owner's voice, client-facing insights notes, newsletter issues, conference talk outlines, case-study write-ups from engagement notes, editing for clarity and authority",
        color: "#e0637c",
      },
      {
        name: "Decks",
        role: "Presentation Designer",
        skills:
          "persuasive business presentations: proposal and kickoff decks, findings and recommendations readouts, executive summaries, clear storyline (situation, complication, resolution), speaker notes, charts specified from data, client-brand-ready formatting",
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
          "client service operations: client briefs and status updates, meeting summaries with action items, account-review presentations, scope and change-request notes, weekly priorities per account, escalation drafts that keep relationships warm",
        color: "#6c8cff",
      },
      {
        name: "Campaigns",
        role: "Campaign Planner",
        skills:
          "campaign strategy and planning: campaign plans with objectives, audience and channel mix, content calendars, creative briefs, launch checklists, budget-split proposals, A/B test plans",
        color: "#e0637c",
      },
      {
        name: "Studio",
        role: "Content Producer",
        skills:
          "production-ready marketing content: platform-specific social posts, ad copy variants, email sequences, blog drafts, landing-page copy, all matched to each client's brand voice from the Library",
        color: "#d979b8",
      },
      {
        name: "Insights",
        role: "Performance Analyst",
        skills:
          "marketing measurement: performance reports with narrative takeaways, KPI dashboards, funnel analysis, benchmark comparisons, post-campaign retrospectives, next-step recommendations grounded in the numbers",
        color: "#7ea6e0",
      },
      {
        name: "Ops",
        role: "Agency Operations",
        skills:
          "how-the-agency-runs: SOPs for repeatable client work, onboarding checklists for new clients and hires, capacity and workload snapshots, vendor and tool comparisons, process documentation into the Library",
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
          "founder-level planning: quarterly goals and OKRs, strategic plans with tradeoffs stated, market and competitive positioning, scenario analysis, decision briefs that lay out options, criteria and a recommendation",
        color: "#ef8354",
      },
      {
        name: "Research",
        role: "Competitive & Market Research",
        skills:
          "decision-grade research: competitor teardowns, market scans, pricing surveys, customer-segment profiles, regulation and trend watch, one-page briefs with sources and confidence levels",
        color: "#7ea6e0",
      },
      {
        name: "Numbers",
        role: "Finance Analyst",
        skills:
          "owner's finance: KPI reviews with narrative, cash-flow and runway snapshots, budget vs. actual analysis, pricing and margin models, scenario what-ifs, board-ready financial summaries",
        color: "#f2d05a",
      },
      {
        name: "Comms",
        role: "Executive Communications",
        skills:
          "the founder's words: investor updates, partner materials, internal announcements, all-hands notes, difficult-message drafts with the right tone, executive bios and company boilerplate",
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
          "pre-call intelligence: account research and prospect briefs, likely priorities and pain points, trigger events worth referencing, org charts and decision-maker profiles, call preparation packs with questions to ask",
        color: "#7ea6e0",
      },
      {
        name: "Sales",
        role: "Sales Manager",
        skills:
          "deal execution: qualification per BANT/MEDDIC-style frameworks, proposal and quote drafts, objection-response one-pagers, negotiation preparation, pipeline summaries and forecast notes, CRM-ready call summaries",
        color: "#6c8cff",
      },
      {
        name: "Outreach",
        role: "Outreach Writer",
        skills:
          "sequences that get replies: personalized cold outreach, multi-touch follow-up sequences, re-engagement and win-back emails, LinkedIn connection notes, meeting-request copy that respects the reader's time",
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
          "people operations per SHRM practice areas: job descriptions with realistic requirements, interview guides and scorecards, onboarding plans, employee handbook policies, performance-review templates, compliance-aware documentation (always recommends counsel for final legal review)",
        color: "#5fd4a2",
      },
      {
        name: "Operations",
        role: "Operations Manager",
        skills:
          "daily execution: procedures and SOPs, vendor comparisons and renewal negotiations prep, scheduling and logistics plans, inventory and tooling checklists, issue triage and root-cause notes",
        color: "#4cc3d9",
      },
      {
        name: "Accounting",
        role: "Accounting Manager",
        skills:
          "small-business finance: bookkeeping structure and monthly-close checklists, invoicing and AR follow-up drafts, expense policies, budget and cash-flow analysis, financial reports with plain-English narrative, tax-season preparation lists",
        color: "#f2d05a",
      },
      {
        name: "Legal",
        role: "Legal Advisor",
        skills:
          "contract and policy hygiene: contract review with risk flags, NDAs, terms of service and privacy policy drafts, compliance checklists, vendor agreement comparisons (always recommends licensed counsel for final review)",
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
          "breaking projects into tasks, delegating work to the right teammate, tracking the kanban board, unblocking the team, status reports, prioritization",
        color: "#6c8cff",
      },
      {
        name: "Architect",
        role: "Software Architect",
        skills:
          "system architecture, tech stack decisions, API design, data modeling, design reviews, technical documentation, scalability planning",
        color: "#a685e2",
      },
      {
        name: "Backend",
        role: "Backend Engineer",
        skills:
          "server-side development, REST/GraphQL APIs, databases and queries, business logic, third-party integrations, performance tuning",
        color: "#5fd4a2",
      },
      {
        name: "Frontend",
        role: "Frontend Engineer",
        skills:
          "UI development, React, HTML/CSS, responsive design, accessibility, state management, UX polish and interaction details",
        color: "#f2a65a",
      },
      {
        name: "Systems",
        role: "Systems & DevOps Engineer",
        skills:
          "infrastructure, deployment pipelines, CI/CD, shell scripting and automation, monitoring, backups, security hardening",
        color: "#4cc3d9",
      },
      {
        name: "QA",
        role: "QA Engineer",
        skills:
          "test plans, writing and running tests, code review, bug hunting and reproduction, regression checks, verifying finished work and moving reviewed tasks to done",
        color: "#e0637c",
      },
    ],
  },
];
