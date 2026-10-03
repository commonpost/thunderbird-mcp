# Testing the plugin (for reviewers)

The Claude Code plugin `commonpost-mcp` only carries the bridge: it needs a Thunderbird with the Commonpost MCP add-on
to answer anything. A test setup takes about ten minutes and needs no account on any service.

1. Install Thunderbird 140 or later (any platform; a fresh profile is fine).
2. Install the add-on: download `commonpost-mcp-v<version>.xpi` from the
   [latest release](https://github.com/commonpost/thunderbird-mcp/releases/latest); in Thunderbird, Tools > Add-ons and
   Themes > gear menu > Install Add-on From File; restart Thunderbird.
3. Sample data: [`docs/sample-mailbox.mbox`](sample-mailbox.mbox) holds 23 fictional messages (example.test and
   example.org addresses). Import it into Local Folders with the ImportExportTools NG add-on, or copy the file as
   `Inbox` into the `Mail/Local Folders/` directory of the profile while Thunderbird is closed.
4. Install the plugin in Claude Code: `claude plugin marketplace add commonpost/thunderbird-mcp`, then
   `claude plugin install commonpost-mcp@commonpost`. Start a session with Thunderbird running.

Prompts that exercise the core tools, with the expected result on the sample mailbox:

- "How many emails did Alice Martin send me in September 2026?" — 4.
- "What is the invoice number and the amount due on the most recent invoice from Nordwind Supplies?" —
  INV-2026-0917, 1,284.50 EUR.
- "Reply to Carol's most recent message about the training room budget and tell her I approve the 4,200 EUR quote.
  Save the reply as a draft; do not send it." — a draft to carol.diaz@example.org appears in Drafts; nothing is sent.
- "Create a folder named Newsletters in Local Folders and move all the Weekly Digest newsletters from my Inbox into
  it." — three messages move.
- "Add a Dentist appointment to my calendar on October 15, 2026 from 14:00 to 15:00." — a review dialog opens in
  Thunderbird (direct creation is blocked by default).

The add-on's options page (Tools > Add-ons and Themes > Commonpost MCP > Preferences) lists the bridges that connected,
with their version.
