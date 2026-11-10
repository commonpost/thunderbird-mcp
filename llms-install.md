# Installing Commonpost MCP for Thunderbird (for AI agents)

Commonpost MCP for Thunderbird is a local stdio MCP server for the mail, calendars, contacts and filters of
Thunderbird 140 or later, on Windows, macOS and Linux. It has two parts: a Thunderbird add-on (`.xpi`) and a Node.js
bridge (`mcp-bridge.cjs`). Thunderbird must be running for the tools to work. It works with any account the user has
set up in Thunderbird (Gmail, Outlook.com, Microsoft 365, IMAP, POP); it does not control the Outlook app and has no
remote endpoint.

Sources: only the GitHub releases of `commonpost/thunderbird-mcp`, the Claude Code plugin and the Gemini CLI
extension below. It is not published on npm, PyPI or Docker Hub: do not use `npx` or `uvx`. Do not run
`scripts/install.sh`: it is for development.

## 1. The add-on (the user does this)

Ask the user to:

1. Download the file ending in `.xpi` from https://github.com/commonpost/thunderbird-mcp/releases/latest
2. In Thunderbird: menu ≡ (top right) > Add-ons and Themes > gear icon > Install Add-on From File, choose the file,
   accept the "full, unrestricted access" warning, then restart Thunderbird.

Wait until they confirm.

## 2. Connect the client

Pick the user's client.

- Claude Desktop (Windows, macOS): ask the user to download the file ending in `.mcpb` from the same release page and
  open it with Claude Desktop. No Node.js needed. Its version number can be lower than the add-on's: that is expected.
- Claude Code:

  ```
  claude plugin marketplace add commonpost/thunderbird-mcp
  claude plugin install commonpost-mcp@commonpost
  ```

- Gemini CLI:

  ```
  gemini extensions install https://github.com/commonpost/thunderbird-mcp
  ```

- Any other stdio client: check `node --version` (22 or later), then download the bridge.

  macOS and Linux:

  ```
  mkdir -p ~/commonpost-mcp && curl -fL -o ~/commonpost-mcp/mcp-bridge.cjs https://github.com/commonpost/thunderbird-mcp/releases/latest/download/mcp-bridge.cjs
  ```

  Windows (PowerShell):

  ```
  New-Item -ItemType Directory -Force "$env:USERPROFILE\commonpost-mcp" | Out-Null; Invoke-WebRequest -OutFile "$env:USERPROFILE\commonpost-mcp\mcp-bridge.cjs" https://github.com/commonpost/thunderbird-mcp/releases/latest/download/mcp-bridge.cjs
  ```

  Then add a server named `commonpost-mail` that runs `node` with the full path of that file as its only argument.
  In JSON configs, write Windows paths with `/` and never use `~`. The configuration file and format of each client
  are in the README, section "Other MCP clients".

## 3. Check

With Thunderbird open, call the tool `listAccounts` (or ask "list my Thunderbird accounts"). It returns the user's
accounts. If it fails: Thunderbird is closed, the add-on is disabled, or the client needs a full restart. More in the
README, section "Troubleshooting".

## 4. Tell the user

- In the add-on's options (menu ≡ > Add-ons and Themes > Commonpost MCP for Thunderbird > wrench button), they choose
  which accounts and tools the assistant may use. Until then, everything is visible.
- Composing opens Thunderbird's review window: nothing is sent without their click. Calendar events are added
  directly by default.
- Updating and removing: README, sections "Updating" and "Uninstall".
