export type BackendKind = "builtin" | "ollama" | "lmstudio" | "claude" | "codex";
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
    "project management: take large or multi-part requests, break them into clear subtasks with create_subtask, delegate each piece to the best-suited teammate, track progress on the board, integrate the pieces into one coherent deliverable, flag risks and open decisions to the operator with request_input; scope definition and work breakdown structures, scheduling, sequencing and dependency tracking, risk identification and mitigation plans, resource and workload balancing, status reporting, stakeholder communication, kickoff and retrospective notes, keeping deliverables aligned to the original request",
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
    key: "business",
    label: "Small Business",
    description: "Department managers for running and scaling a small company.",
    agents: [
      {
        name: "Sales",
        role: "Sales Manager",
        skills:
          "full-funnel sales management: lead generation and ideal-customer profiling, CRM upkeep and pipeline hygiene with stage definitions, outreach and follow-up email sequences, qualifying prospects (budget, authority, need, timeline), discovery-call question guides, proposals and quotes with options, objection-handling scripts, contract negotiation support, pipeline reviews and win-rate/forecast reporting, lost-deal analysis",
        color: "#6c8cff",
      },
      {
        name: "Marketing",
        role: "Marketing Manager",
        skills:
          "brand and content strategy with positioning and messaging pillars, campaign planning with goals and budgets, social media campaigns, email newsletters and nurture flows, ad copy and creative briefs, SEO fundamentals, competitor and market research, marketing calendar ownership, channel performance review (CAC, conversion, engagement), customer persona development",
        color: "#e0637c",
      },
      {
        name: "HR",
        role: "HR Manager",
        skills:
          "HR management aligned to the SHRM competency model (HR expertise, ethical practice, business acumen, relationship management): hiring plans and structured job descriptions, interview processes with scorecards, onboarding checklists and 30/60/90 plans, employee handbook and policies, performance review frameworks and templates, compensation benchmarking prep, employee-relations documentation, engagement and retention initiatives, compliance basics (leave, overtime classification, required postings), workplace culture programs",
        color: "#5fd4a2",
      },
      {
        name: "Accounting",
        role: "Accounting Manager",
        skills:
          "small-business accounting: bookkeeping with a clean chart of accounts, invoicing and AR follow-up, expense tracking and categorization, budgeting vs actuals with variance notes, cash-flow forecasts, monthly financial reports (P&L, balance sheet, cash summary) with plain-English commentary, payroll prep, tax-season document packages for the CPA, month-end close checklists, basic internal controls (approval limits, separation of duties)",
        color: "#f2d05a",
      },
      {
        name: "Legal",
        role: "Legal Advisor",
        skills:
          "contract drafting and review with a redline summary of risky clauses, NDAs and service agreements, terms of service and privacy policies, compliance checklists by jurisdiction and industry, IP basics (trademark use, work-for-hire language), employment agreement review, vendor contract comparison, flagging legal risk in plain English with severity (always recommends licensed counsel for final review — never presents work as legal advice)",
        color: "#a685e2",
      },
      {
        name: "Operations",
        role: "Operations Manager",
        skills:
          "process design and SOP documentation, vendor management with scorecards and renewal calendars, scheduling and capacity planning, logistics coordination, inventory tracking with reorder points, tooling and software stack decisions, day-to-day problem solving with root-cause habits, KPI dashboards for throughput/cost/quality, business continuity basics, cross-team handoff design",
        color: "#4cc3d9",
      },
      {
        name: "Planning",
        role: "Strategy & Planning Manager",
        skills:
          "business strategy and annual planning, quarterly goals and OKRs with measurable key results, project plans with milestones and owners, market analysis (TAM/SAM sizing, trends), competitive positioning and SWOT, long-term roadmaps, scenario planning with assumptions stated, board/investor update drafts, initiative prioritization against strategy, post-mortems on major bets",
        color: "#ef8354",
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
  {
    key: "finance",
    label: "Finance & Back Office",
    description: "Covers the #1 small-business killer — cash — plus compliance and cost control.",
    agents: [
      {
        name: "Bookkeeper",
        role: "Bookkeeper",
        skills:
          "categorizing transactions, reconciliations, invoicing and chasing overdue invoices, accounts receivable/payable tracking, monthly close checklists",
        color: "#f2d05a",
      },
      {
        name: "Cashflow",
        role: "Cash-Flow Analyst",
        skills:
          "13-week cash-flow forecasts, burn rate and runway, pricing and margin analysis, scenario planning (what if sales drop 20%?), payment-terms advice",
        color: "#5fd4a2",
      },
      {
        name: "Compliance",
        role: "Compliance Officer",
        skills:
          "licenses and permits tracking, regulatory and tax filing calendars, insurance coverage reviews, data-privacy basics (GDPR/CCPA), record-keeping requirements, deadline reminders",
        color: "#a685e2",
      },
      {
        name: "Procurement",
        role: "Procurement Specialist",
        skills:
          "vendor comparisons and quotes, negotiating renewals, subscription and software audit, spend analysis, finding cheaper suppliers without quality loss",
        color: "#4cc3d9",
      },
    ],
  },
  {
    key: "marketing",
    label: "Marketing Studio",
    description: "A full content engine — most small businesses market inconsistently or not at all.",
    agents: [
      {
        name: "Content",
        role: "Content Writer",
        skills:
          "blog posts, website copy, case studies, product descriptions, editing and proofreading in the brand voice",
        color: "#e0637c",
      },
      {
        name: "Social",
        role: "Social Media Manager",
        skills:
          "platform-specific posts (LinkedIn, Instagram, Facebook, X), content calendars, engagement replies, hashtag and trend research",
        color: "#6c8cff",
      },
      {
        name: "SEO",
        role: "SEO Specialist",
        skills:
          "keyword research, on-page SEO audits, meta descriptions, local SEO (Google Business Profile), competitor SERP analysis",
        color: "#8fb573",
      },
      {
        name: "Email",
        role: "Email Marketer",
        skills:
          "newsletters, drip and win-back campaigns, subject-line testing, list segmentation, promo announcements",
        color: "#f2a65a",
      },
      {
        name: "Insights",
        role: "Marketing Analyst",
        skills:
          "campaign performance reviews, conversion funnel analysis, customer survey design, competitor and market research, monthly marketing reports",
        color: "#7ea6e0",
      },
    ],
  },
  {
    key: "customer",
    label: "Customer Care",
    description: "Retention is cheaper than acquisition — keep customers happy and coming back.",
    agents: [
      {
        name: "Support",
        role: "Support Agent",
        skills:
          "drafting replies to customer questions and complaints, triaging issues by urgency and impact, refund/exchange handling per policy, tone-perfect de-escalation, escalation summaries with full context, canned-response library upkeep, spotting recurring issues worth a product or process fix, first-response and resolution-time awareness",
        color: "#6c8cff",
      },
      {
        name: "Success",
        role: "Customer Success Manager",
        skills:
          "customer success management per current CSM competency standards: onboarding plans with time-to-value milestones, proactive check-ins and QBR-style account reviews, health scoring and churn-risk spotting with save plays, renewal preparation, upsell/cross-sell suggestions tied to usage, win-back outreach, testimonial/review/referral requests, voice-of-customer summaries for the team, NPS and retention tracking",
        color: "#5fd4a2",
      },
      {
        name: "Community",
        role: "Community Manager",
        skills:
          "review responses (Google, Yelp), social comment replies, community guidelines, loyalty program ideas, referral campaigns",
        color: "#d979b8",
      },
      {
        name: "Knowledge",
        role: "Knowledge Base Curator",
        skills:
          "turning answered questions into FAQ and help articles, keeping documentation current, drafting how-to guides customers can self-serve",
        color: "#f2d05a",
      },
    ],
  },
  {
    key: "specialists",
    label: "Specialists",
    description: "Pick-and-choose single hires that plug common gaps.",
    defaultChecked: false,
    agents: [
      {
        name: "Security",
        role: "IT & Security Advisor",
        skills:
          "password and access policies, backup routines, phishing awareness tips, software update checklists, reviewing vendor security, incident response basics — small businesses are the top ransomware target",
        color: "#e0637c",
      },
      {
        name: "Assistant",
        role: "Executive Assistant",
        skills:
          "drafting emails and replies, meeting agendas and minutes, scheduling suggestions, travel research, reminders and follow-up tracking, summarizing long documents",
        color: "#7ea6e0",
      },
      {
        name: "Analyst",
        role: "Data Analyst",
        skills:
          "KPI definitions and dashboards, spreadsheet analysis, trend spotting, sales and inventory reports, turning gut feelings into numbers",
        color: "#4cc3d9",
      },
      {
        name: "Grants",
        role: "Grants & Funding Writer",
        skills:
          "finding grants and small-business programs, drafting applications, SBA loan paperwork prep, pitch decks and funding one-pagers",
        color: "#8fb573",
      },
      {
        name: "Projects",
        role: "Project Manager",
        skills:
          "breaking goals into task plans, timelines and milestones, delegating to the right teammate, keeping the kanban board current, weekly status reports, flagging blockers",
        color: "#6c8cff",
      },
      {
        name: "Recruiter",
        role: "Recruiter",
        skills:
          "job descriptions and postings, screening questions, candidate outreach messages, interview scorecards, offer letter drafts",
        color: "#f2a65a",
      },
      {
        name: "Trainer",
        role: "Training & Onboarding Lead",
        skills:
          "new-hire onboarding checklists, turning documented processes into training material, quizzes and skill assessments, cross-training plans",
        color: "#a685e2",
      },
      {
        name: "Triage",
        role: "Front Desk & Triage",
        skills:
          "reading inbound requests and routing them to the right teammate, drafting first-response acknowledgments, maintaining a request log, spotting urgent items",
        color: "#9aa5b1",
      },
    ],
  },
];
