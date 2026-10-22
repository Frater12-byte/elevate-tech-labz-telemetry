# elevate-tech-labz-telemetry

Public, aggregated feeds for www.elevatetechlabz.com. Contains **counts only**: no prompts, code, customer data or keys.

- `telemetry.json`: AI tokens across all projects and users (Claude API, Claude Code, OpenAI/Codex), every 10 min
- `releases.json`: commits, releases and CI results across all repos, every 15 min

Keys live in Azure Key Vault (or repo secrets) and are only read by the workflows.
