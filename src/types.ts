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

export type Column = "todo" | "in_progress" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  agent_id: string | null;
  origin: string;
  kind: "task" | "chat" | "message";
  status: "draft" | "routing" | "queued" | "running" | "done" | "failed" | "cancelled";
  column: Column;
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

/** Additional single-agent templates offered in the New Agent picker. */
export const EXTRA_ROLES: TemplateAgent[] = [
  {
    name: "QE",
    role: "Quality Engineer (Manufacturing)",
    skills:
      "quality control plans, inspection checklists, SPC and control charts, root-cause analysis (5 Whys, fishbone), CAPA tracking, ISO 9001 documentation, supplier quality audits",
    color: "#e0637c",
  },
  {
    name: "ProcessEng",
    role: "Process Engineer",
    skills:
      "process mapping and optimization, cycle-time and bottleneck analysis, lean/six-sigma methods, work instructions, equipment utilization, waste reduction",
    color: "#4cc3d9",
  },
  {
    name: "SupplyChain",
    role: "Supply Chain Manager",
    skills:
      "demand forecasting, inventory planning, supplier scorecards, lead-time tracking, purchase order management, shortage risk flagging",
    color: "#8fb573",
  },
  {
    name: "Logistics",
    role: "Logistics Coordinator",
    skills:
      "shipment scheduling, carrier comparison, freight quotes, customs paperwork prep, delivery tracking and exception handling",
    color: "#7ea6e0",
  },
  {
    name: "Safety",
    role: "EHS & Safety Officer",
    skills:
      "safety procedures and toolbox talks, OSHA compliance checklists, incident reports and investigations, PPE requirements, safety training material",
    color: "#f2a65a",
  },
  {
    name: "Maintenance",
    role: "Maintenance Planner",
    skills:
      "preventive maintenance schedules, spare-parts inventory, downtime logs and analysis, work order writing, equipment lifecycle tracking",
    color: "#9aa5b1",
  },
  {
    name: "Product",
    role: "Product Manager",
    skills:
      "product requirements and specs, feature prioritization, user feedback synthesis, competitive teardown, release notes, roadmap communication",
    color: "#6c8cff",
  },
  {
    name: "UX",
    role: "UX Designer",
    skills:
      "user flows, wireframe descriptions, usability heuristics review, copy and microcopy, accessibility checks, design critique",
    color: "#d979b8",
  },
  {
    name: "PR",
    role: "PR & Communications",
    skills:
      "press releases, media pitches, company announcements, crisis communication drafts, award submissions, internal newsletters",
    color: "#a685e2",
  },
  {
    name: "BizDev",
    role: "Partnerships & Business Development",
    skills:
      "partner prospecting, outreach and follow-up, partnership proposals, channel strategy, event and conference planning",
    color: "#5fd4a2",
  },
  {
    name: "FieldService",
    role: "Field Service Coordinator",
    skills:
      "service call scheduling, technician dispatch notes, service reports, warranty tracking, customer follow-ups after visits",
    color: "#ef8354",
  },
  {
    name: "Estimator",
    role: "Estimator (Quoting)",
    skills:
      "job costing, bill of materials, labor estimates, quote documents, margin checks, win/loss tracking on bids",
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
          "lead generation, CRM upkeep, outreach and follow-up emails, qualifying prospects, proposals, quotes, contract negotiation support",
        color: "#6c8cff",
      },
      {
        name: "Marketing",
        role: "Marketing Manager",
        skills:
          "brand and content strategy, social media campaigns, email newsletters, ad copy, SEO, competitor and market research",
        color: "#e0637c",
      },
      {
        name: "HR",
        role: "HR Manager",
        skills:
          "hiring plans, job descriptions, interview processes, onboarding, employee handbook and policies, performance reviews, workplace culture",
        color: "#5fd4a2",
      },
      {
        name: "Accounting",
        role: "Accounting Manager",
        skills:
          "bookkeeping, invoicing, expense tracking, budgeting, cash-flow forecasts, financial reports, payroll prep, tax season support",
        color: "#f2d05a",
      },
      {
        name: "Legal",
        role: "Legal Advisor",
        skills:
          "contract drafting and review, NDAs, terms of service, privacy policies, compliance checklists, flagging legal risk (always recommends licensed counsel for final review)",
        color: "#a685e2",
      },
      {
        name: "Operations",
        role: "Operations Manager",
        skills:
          "process design and documentation, vendor management, scheduling, logistics, inventory, tooling, day-to-day problem solving",
        color: "#4cc3d9",
      },
      {
        name: "Planning",
        role: "Strategy & Planning Manager",
        skills:
          "business strategy, quarterly goals and OKRs, project plans, market analysis, competitive positioning, long-term roadmaps",
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
          "drafting replies to customer questions and complaints, triaging issues by urgency, refund/exchange handling per policy, tone-perfect de-escalation",
        color: "#6c8cff",
      },
      {
        name: "Success",
        role: "Customer Success Manager",
        skills:
          "customer onboarding plans, proactive check-ins, churn-risk spotting, upsell/cross-sell suggestions, win-back outreach, testimonial and review requests",
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
