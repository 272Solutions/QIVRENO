# Qivreno plugins

Qivreno has two extension points, and they have deliberately different trust
levels:

| | **Skill packs** | **MCP tool servers** |
|---|---|---|
| What it adds | agent roles, teams, Library documents | new tools agents can call |
| What it is | plain text files | a program running on your computer |
| Risk | it is data — read it like a document | it runs with your permissions |
| Enabled by | dropping a folder in | an explicit toggle, after you see the command |

Nothing installs or runs itself. Packs are read at startup; MCP servers start
only when you enable them in **Settings → Plugins & tools**.

## Skill packs

A pack is a folder in `~/Qivreno/Plugins/` containing a `plugin.json` and the
markdown files it references. A complete worked example lives in
[`examples/plugins/starter-pack`](../examples/plugins/starter-pack) — copy it
and edit.

```
~/Qivreno/Plugins/my-pack/
  plugin.json
  agents/researcher.md      # skill documents
  docs/onboarding.md        # Library documents
```

### plugin.json

```jsonc
{
  "id": "my-pack",              // folder name is used if omitted
  "name": "My Pack",
  "version": "1.0.0",
  "author": "you",
  "description": "One line shown in Settings.",
  "homepage": "https://…",

  "agents": [{
    "name": "Researcher",       // shown in New Agent + Quick Start
    "role": "Market Researcher",
    "description": "Friendly one-liner the operator reads.",
    "color": "#6c8cff",
    "skills_file": "agents/researcher.md"   // or inline "skills": "…"
  }],

  "teams": [{                   // optional: a one-click Quick Start team
    "key": "research",
    "label": "Research Desk",
    "description": "Shown under Quick Start Team.",
    "agents": ["Researcher"]    // must be names defined above
  }],

  "docs": [{                    // optional: installed into the Library
    "title": "Interview Guide",
    "kind": "process",          // "process" | "business"
    "file": "docs/interviews.md"
  }],

  "mcp_servers": [{             // optional: suggested only, never auto-run
    "name": "github",
    "description": "Why the pack wants it.",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"]
  }]
}
```

### Writing a good skill document

The `skills` text is the agent's working prompt, not marketing copy. The
built-in roles follow a shape worth copying: open with
`<domain> per <named professional standard> practice:` then a semicolon-run of
concrete methods, and close with a `deliverable standard:` clause stating what
a finished artifact contains. That closing clause does real work — it is what
stops a local model returning an outline where a document was asked for.

Documents are installed by title and never overwrite an existing one, so a
pack cannot clobber your edits.

## MCP tool servers

Qivreno is an [MCP](https://modelcontextprotocol.io) host, so any MCP server
works — GitHub, Postgres, Slack, filesystems, or one you write. Add one in
**Settings → Plugins & tools**, or install a pack that suggests one and click
Add, then enable it.

Tools appear to agents namespaced as `mcp__<server>__<tool>`, so they can never
shadow a built-in tool. Agents on Built-in AI, Ollama, LM Studio, Gemini and
Grok get them automatically; Claude and Codex agents use their own CLI tooling.

Transport is stdio, tools only. Every call is bounded by a timeout, so a server
that stops answering fails that one call instead of hanging the agent.

### Before you enable one

An MCP server is a program with your permissions. Read the command shown in
Settings. Prefer servers whose source you can see, pin versions rather than
tracking latest, and scope filesystem servers to a specific folder rather than
your home directory.

## Sharing a pack

A pack is a folder, so any distribution works today: a GitHub repo, a zip, a
gist. Include the `plugin.json`, the markdown it references, and a README
saying what it adds and why.

A hosted index that lists community packs is the natural next step; the format
above is stable and designed for it — an index entry needs only a name,
description and a repository URL.
